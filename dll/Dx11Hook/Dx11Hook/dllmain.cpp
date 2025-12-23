#include "pch.h"

#include <Windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <atomic>
#include <vector>
#include <cstdint>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

#include "MinHook.h"

// ============================================================
// Globals: DX11 hook
// ============================================================

typedef HRESULT(__stdcall* PresentFn)(
    IDXGISwapChain*,
    UINT,
    UINT
    );

PresentFn oPresent = nullptr;
void* g_Present = nullptr;

ID3D11Device* g_Device = nullptr;
ID3D11DeviceContext* g_Context = nullptr;
ID3D11Texture2D* g_StagingTexture = nullptr;

// staging tracking
UINT g_StagingWidth = 0;
UINT g_StagingHeight = 0;
DXGI_FORMAT g_StagingFormat = DXGI_FORMAT_UNKNOWN;

// ============================================================
// Ring buffer definitions
// ============================================================

constexpr int RING_SIZE = 3;

struct FrameSlot
{
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t rowPitch = 0;
    uint64_t frameId = 0;
    std::vector<uint8_t> pixels;
};

struct RingBuffer
{
    FrameSlot slots[RING_SIZE];
    std::atomic<uint32_t> writeIndex{ 0 };
    std::atomic<uint32_t> readIndex{ 0 };
};

RingBuffer g_RingBuffer;
std::atomic<uint64_t> g_FrameCounter{ 0 };
std::atomic<bool> g_Running{ true };

// ============================================================
// Forward declarations
// ============================================================

HWND CreateDummyWindow();
bool CreateDummyD3D11Device(ID3D11Device**, ID3D11DeviceContext**);
IDXGISwapChain* CreateDummySwapChain(ID3D11Device*, HWND);
void ExtractPresent(IDXGISwapChain*);
DWORD WINAPI ConsumerThread(LPVOID);

HRESULT __stdcall HookedPresent(
    IDXGISwapChain*,
    UINT,
    UINT
);

// ============================================================
// DLL entry
// ============================================================

BOOL APIENTRY DllMain(
    HMODULE hModule,
    DWORD reason,
    LPVOID
)
{
    if (reason == DLL_PROCESS_ATTACH)
    {
        DisableThreadLibraryCalls(hModule);

        CreateThread(nullptr, 0, ConsumerThread, nullptr, 0, nullptr);

        CreateThread(nullptr, 0, [](LPVOID) -> DWORD
            {
                Sleep(2000);

                HWND hwnd = CreateDummyWindow();
                ID3D11Device* device = nullptr;
                ID3D11DeviceContext* context = nullptr;

                if (!CreateDummyD3D11Device(&device, &context))
                    return 0;

                IDXGISwapChain* sc = CreateDummySwapChain(device, hwnd);
                if (!sc)
                    return 0;

                ExtractPresent(sc);

                MH_Initialize();
                MH_CreateHook(
                    g_Present,
                    &HookedPresent,
                    reinterpret_cast<void**>(&oPresent)
                );
                MH_EnableHook(g_Present);

                OutputDebugStringA("[Ring] Present hook installed\n");

                sc->Release();
                context->Release();
                device->Release();

                return 0;
            }, nullptr, 0, nullptr);
    }

    if (reason == DLL_PROCESS_DETACH)
    {
        g_Running = false;
    }

    return TRUE;
}

// ============================================================
// Producer: Hooked Present
// ============================================================

HRESULT __stdcall HookedPresent(
    IDXGISwapChain* swapChain,
    UINT SyncInterval,
    UINT Flags
)
{
    static bool initialized = false;

    if (!initialized)
    {
        if (SUCCEEDED(swapChain->GetDevice(
            __uuidof(ID3D11Device),
            (void**)&g_Device)))
        {
            g_Device->GetImmediateContext(&g_Context);
            OutputDebugStringA("[Ring] Device + Context acquired\n");
            initialized = true;
        }
    }

    ID3D11Texture2D* backBuffer = nullptr;
    if (FAILED(swapChain->GetBuffer(
        0,
        __uuidof(ID3D11Texture2D),
        (void**)&backBuffer)))
    {
        return oPresent(swapChain, SyncInterval, Flags);
    }

    D3D11_TEXTURE2D_DESC bbDesc{};
    backBuffer->GetDesc(&bbDesc);

    // ---- FIX: recreate staging texture if size/format changed ----
    bool recreate =
        !g_StagingTexture ||
        g_StagingWidth != bbDesc.Width ||
        g_StagingHeight != bbDesc.Height ||
        g_StagingFormat != bbDesc.Format;

    if (recreate)
    {
        if (g_StagingTexture)
        {
            g_StagingTexture->Release();
            g_StagingTexture = nullptr;
        }

        D3D11_TEXTURE2D_DESC stagingDesc = bbDesc;
        stagingDesc.Usage = D3D11_USAGE_STAGING;
        stagingDesc.BindFlags = 0;
        stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        stagingDesc.MiscFlags = 0;

        if (SUCCEEDED(g_Device->CreateTexture2D(
            &stagingDesc,
            nullptr,
            &g_StagingTexture)))
        {
            g_StagingWidth = bbDesc.Width;
            g_StagingHeight = bbDesc.Height;
            g_StagingFormat = bbDesc.Format;

            OutputDebugStringA(
                "[Ring] Staging texture recreated\n"
            );
        }
    }

    g_Context->CopyResource(g_StagingTexture, backBuffer);

    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (SUCCEEDED(g_Context->Map(
        g_StagingTexture,
        0,
        D3D11_MAP_READ,
        0,
        &mapped)))
    {
        uint32_t index =
            g_RingBuffer.writeIndex.load() % RING_SIZE;

        FrameSlot& slot = g_RingBuffer.slots[index];

        size_t dataSize = bbDesc.Height * mapped.RowPitch;
        if (slot.pixels.size() != dataSize)
            slot.pixels.resize(dataSize);

        memcpy(slot.pixels.data(), mapped.pData, dataSize);

        slot.width = bbDesc.Width;
        slot.height = bbDesc.Height;
        slot.rowPitch = mapped.RowPitch;
        slot.frameId = g_FrameCounter++;

        g_RingBuffer.writeIndex++;

        g_Context->Unmap(g_StagingTexture, 0);
    }

    backBuffer->Release();
    return oPresent(swapChain, SyncInterval, Flags);
}

// ============================================================
// Consumer thread
// ============================================================

DWORD WINAPI ConsumerThread(LPVOID)
{
    while (g_Running)
    {
        uint32_t read = g_RingBuffer.readIndex.load();
        uint32_t write = g_RingBuffer.writeIndex.load();

        if (read < write)
        {
            FrameSlot& slot =
                g_RingBuffer.slots[read % RING_SIZE];

            char msg[128];
            sprintf_s(
                msg,
                "[Consumer] Frame %llu (%ux%u)\n",
                slot.frameId,
                slot.width,
                slot.height
            );

            OutputDebugStringA(msg);
            g_RingBuffer.readIndex++;
        }
        else
        {
            Sleep(1);
        }
    }

    return 0;
}

// ============================================================
// Dummy DX11 setup
// ============================================================

LRESULT CALLBACK DummyWndProc(HWND h, UINT m, WPARAM w, LPARAM l)
{
    return DefWindowProc(h, m, w, l);
}

HWND CreateDummyWindow()
{
    WNDCLASSEX wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = DummyWndProc;
    wc.hInstance = GetModuleHandle(nullptr);
    wc.lpszClassName = L"DummyDX11Window";

    RegisterClassEx(&wc);

    return CreateWindowEx(
        0,
        wc.lpszClassName,
        L"Dummy",
        WS_OVERLAPPEDWINDOW,
        0, 0, 100, 100,
        nullptr,
        nullptr,
        wc.hInstance,
        nullptr
    );
}

bool CreateDummyD3D11Device(
    ID3D11Device** device,
    ID3D11DeviceContext** context)
{
    D3D_FEATURE_LEVEL level;
    D3D_FEATURE_LEVEL levels[] = {
        D3D_FEATURE_LEVEL_11_0
    };

    return SUCCEEDED(D3D11CreateDevice(
        nullptr,
        D3D_DRIVER_TYPE_HARDWARE,
        nullptr,
        0,
        levels,
        1,
        D3D11_SDK_VERSION,
        device,
        &level,
        context
    ));
}

IDXGISwapChain* CreateDummySwapChain(
    ID3D11Device* device,
    HWND hwnd)
{
    IDXGIDevice* dxgi;
    IDXGIAdapter* adapter;
    IDXGIFactory* factory;

    device->QueryInterface(
        __uuidof(IDXGIDevice),
        (void**)&dxgi);
    dxgi->GetAdapter(&adapter);
    adapter->GetParent(
        __uuidof(IDXGIFactory),
        (void**)&factory);

    DXGI_SWAP_CHAIN_DESC desc{};
    desc.BufferCount = 2;
    desc.BufferDesc.Format =
        DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.BufferUsage =
        DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.OutputWindow = hwnd;
    desc.SampleDesc.Count = 1;
    desc.Windowed = TRUE;

    IDXGISwapChain* sc = nullptr;
    factory->CreateSwapChain(device, &desc, &sc);

    factory->Release();
    adapter->Release();
    dxgi->Release();

    return sc;
}

void ExtractPresent(IDXGISwapChain* sc)
{
    void** vtable = *reinterpret_cast<void***>(sc);
    g_Present = vtable[8];
}
