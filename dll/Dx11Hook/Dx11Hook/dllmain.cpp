// ===============================
// capture.cpp
// ===============================

#include "pch.h"
#include <Windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <atomic>
#include <vector>
#include <cstdint>

#include "MinHook.h"

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

// ============================================================
// Globals
// ============================================================

ID3D11Device* g_Device = nullptr;
ID3D11DeviceContext* g_Context = nullptr;
ID3D11Texture2D* g_Staging = nullptr;

std::atomic<bool> g_Running{ true };
std::atomic<uint64_t> g_FrameId{ 0 };

// ============================================================
// Ring Buffer
// ============================================================

constexpr int RING_SIZE = 3;

struct FrameSlot {
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t rowPitch = 0;
    uint64_t frameId = 0;
    std::vector<uint8_t> pixels;
};

struct RingBuffer {
    FrameSlot slots[RING_SIZE];
    std::atomic<uint32_t> writeIndex{ 0 };
    std::atomic<uint32_t> readIndex{ 0 };
};

RingBuffer g_Ring;

// ============================================================
// Frame Header (40 bytes)
// ============================================================

#pragma pack(push, 1)
struct FrameHeader {
    uint32_t magic;        // 'FRAM'
    uint32_t headerSize;   // sizeof(FrameHeader)
    uint64_t frameId;
    uint64_t writeTimeNs;
    uint32_t width;
    uint32_t height;
    uint32_t rowPitch;
    uint32_t payloadSize;
};
#pragma pack(pop)

// ============================================================
// Timing
// ============================================================

uint64_t NowNs() {
    LARGE_INTEGER freq, t;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&t);
    return (t.QuadPart * 1000000000ULL) / freq.QuadPart;
}

// ============================================================
// Named Pipe
// ============================================================

HANDLE CreatePipeServer() {
    return CreateNamedPipeA(
        "\\\\.\\pipe\\frame_pipe",
        PIPE_ACCESS_OUTBOUND,
        PIPE_TYPE_BYTE | PIPE_WAIT,
        1,
        1 << 20,
        1 << 20,
        0,
        nullptr
    );
}

// ============================================================
// Consumer Thread
// ============================================================

DWORD WINAPI ConsumerThread(LPVOID) {
    HANDLE pipe = CreatePipeServer();
    if (pipe == INVALID_HANDLE_VALUE)
        return 0;

    ConnectNamedPipe(pipe, nullptr);
    OutputDebugStringA("[DLL] Pipe connected\n");

    while (g_Running) {
        uint32_t r = g_Ring.readIndex.load();
        uint32_t w = g_Ring.writeIndex.load();

        if (r >= w) {
            Sleep(1);
            continue;
        }

        FrameSlot& slot = g_Ring.slots[r % RING_SIZE];

        // ---- pack rows (remove rowPitch padding) ----
        uint32_t tightRow = slot.width * 4;
        uint32_t packedSize = slot.height * tightRow;

        std::vector<uint8_t> packed(packedSize);

        for (uint32_t y = 0; y < slot.height; y++) {
            memcpy(
                packed.data() + y * tightRow,
                slot.pixels.data() + y * slot.rowPitch,
                tightRow
            );
        }

        FrameHeader hdr{};
        hdr.magic = 0x4D415246; // 'FRAM'
        hdr.headerSize = sizeof(FrameHeader);
        hdr.frameId = slot.frameId;
        hdr.writeTimeNs = NowNs();
        hdr.width = slot.width;
        hdr.height = slot.height;
        hdr.rowPitch = tightRow;
        hdr.payloadSize = packedSize;

        DWORD written = 0;

        if (!WriteFile(pipe, &hdr, sizeof(hdr), &written, nullptr)) {
            Sleep(1);
            continue;
        }

        if (!WriteFile(pipe, packed.data(), packedSize, &written, nullptr)) {
            Sleep(1);
            continue;
        }

        g_Ring.readIndex++;
    }

    FlushFileBuffers(pipe);
    DisconnectNamedPipe(pipe);
    CloseHandle(pipe);
    return 0;
}

// ============================================================
// DX11 Present Hook
// ============================================================

typedef HRESULT(__stdcall* PresentFn)(IDXGISwapChain*, UINT, UINT);
PresentFn oPresent = nullptr;

HRESULT __stdcall HookedPresent(IDXGISwapChain* swap, UINT sync, UINT flags) {
    static bool init = false;
    OutputDebugStringA("Present called\n");
    static int count = 0;
    count++;
    if (count == 100) {
        OutputDebugStringA("[DLL] 100 Presents reached\n");
    }



    if (!init) {
        swap->GetDevice(__uuidof(ID3D11Device), (void**)&g_Device);
        g_Device->GetImmediateContext(&g_Context);
        init = true;
        OutputDebugStringA("[DLL] HookedPresent active\n");
    }

    ID3D11Texture2D* backBuffer = nullptr;
    if (FAILED(swap->GetBuffer(0, __uuidof(ID3D11Texture2D), (void**)&backBuffer)))
        return oPresent(swap, sync, flags);

    D3D11_TEXTURE2D_DESC desc{};
    backBuffer->GetDesc(&desc);

    if (desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB) {
        desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    }

    if (!g_Staging ||
        g_Ring.slots[0].width != desc.Width ||
        g_Ring.slots[0].height != desc.Height) {

        if (g_Staging) g_Staging->Release();

        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        desc.MiscFlags = 0;

        g_Device->CreateTexture2D(&desc, nullptr, &g_Staging);
    }

    g_Context->CopyResource(g_Staging, backBuffer);

    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (SUCCEEDED(g_Context->Map(g_Staging, 0, D3D11_MAP_READ, 0, &mapped))) {

        uint32_t idx = g_Ring.writeIndex.load() % RING_SIZE;
        FrameSlot& slot = g_Ring.slots[idx];

        slot.width = desc.Width;
        slot.height = desc.Height;
        slot.rowPitch = mapped.RowPitch;
        slot.frameId = g_FrameId++;

        size_t size = desc.Height * mapped.RowPitch;
        slot.pixels.resize(size);
        memcpy(slot.pixels.data(), mapped.pData, size);

        g_Ring.writeIndex++;
        g_Context->Unmap(g_Staging, 0);
    }

    backBuffer->Release();
    return oPresent(swap, sync, flags);
}

// ============================================================
// Hook Installer
// ============================================================

DWORD WINAPI InitHookThread(LPVOID) {
    Sleep(2000);

    IDXGISwapChain* swap = nullptr;
    ID3D11Device* dev = nullptr;
    ID3D11DeviceContext* ctx = nullptr;

    DXGI_SWAP_CHAIN_DESC sd{};
    sd.BufferCount = 1;
    sd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.OutputWindow = GetForegroundWindow();
    sd.SampleDesc.Count = 1;
    sd.Windowed = TRUE;

    D3D11CreateDeviceAndSwapChain(
        nullptr,
        D3D_DRIVER_TYPE_HARDWARE,
        nullptr,
        0,
        nullptr,
        0,
        D3D11_SDK_VERSION,
        &sd,
        &swap,
        &dev,
        nullptr,
        &ctx
    );

    void** vtbl = *reinterpret_cast<void***>(swap);
    void* present = vtbl[8];

    MH_Initialize();
    MH_CreateHook(present, &HookedPresent, (void**)&oPresent);
    MH_EnableHook(present);

    OutputDebugStringA("[DLL] Present hook installed\n");

    swap->Release();
    ctx->Release();
    dev->Release();

    return 0;
}

// ============================================================
// DLL ENTRY
// ============================================================

BOOL APIENTRY DllMain(HMODULE mod, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(mod);
        CreateThread(nullptr, 0, ConsumerThread, nullptr, 0, nullptr);
        CreateThread(nullptr, 0, InitHookThread, nullptr, 0, nullptr);
    }

    if (reason == DLL_PROCESS_DETACH) {
        g_Running = false;
    }

    return TRUE;
}
