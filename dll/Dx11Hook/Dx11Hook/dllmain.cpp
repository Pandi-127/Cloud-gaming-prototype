#include "pch.h"

#include <Windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <cstdint>
#include <fstream>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

#include "MinHook.h"

// ------------------------------------------------------------
// Globals
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// Forward declarations
// ------------------------------------------------------------

HWND CreateDummyWindow();
bool CreateDummyD3D11Device(ID3D11Device**, ID3D11DeviceContext**);
IDXGISwapChain* CreateDummySwapChain(ID3D11Device*, HWND);
void ExtractPresent(IDXGISwapChain*);

HRESULT __stdcall HookedPresent(
    IDXGISwapChain*,
    UINT,
    UINT
);

// ------------------------------------------------------------
// Save BMP helper
// ------------------------------------------------------------

void SaveBMP(
    const char* filename,
    uint8_t* rgbaData,
    int width,
    int height,
    int rowPitch
)
{
    BITMAPFILEHEADER fileHeader{};
    BITMAPINFOHEADER infoHeader{};

    int imageSize = width * height * 4;

    fileHeader.bfType = 0x4D42; // BM
    fileHeader.bfOffBits =
        sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER);
    fileHeader.bfSize = fileHeader.bfOffBits + imageSize;

    infoHeader.biSize = sizeof(BITMAPINFOHEADER);
    infoHeader.biWidth = width;
    infoHeader.biHeight = height;
    infoHeader.biPlanes = 1;
    infoHeader.biBitCount = 32;
    infoHeader.biCompression = BI_RGB;

    std::ofstream file(filename, std::ios::binary);
    file.write((char*)&fileHeader, sizeof(fileHeader));
    file.write((char*)&infoHeader, sizeof(infoHeader));

    // BMP is bottom-up
    for (int y = height - 1; y >= 0; --y)
    {
        uint8_t* row = rgbaData + y * rowPitch;

        for (int x = 0; x < width; ++x)
        {
            uint8_t r = row[x * 4 + 0];
            uint8_t g = row[x * 4 + 1];
            uint8_t b = row[x * 4 + 2];
            uint8_t a = row[x * 4 + 3];

            file.put(b);
            file.put(g);
            file.put(r);
            file.put(a);
        }
    }

    file.close();
}

// ------------------------------------------------------------
// Worker thread
// ------------------------------------------------------------

DWORD WINAPI WorkerThread(LPVOID)
{
    Sleep(2000);

    HWND hwnd = CreateDummyWindow();
    if (!hwnd) return 0;

    ID3D11Device* device = nullptr;
    ID3D11DeviceContext* context = nullptr;

    if (!CreateDummyD3D11Device(&device, &context))
        return 0;

    IDXGISwapChain* swapChain = CreateDummySwapChain(device, hwnd);
    if (!swapChain)
        return 0;

    ExtractPresent(swapChain);

    MH_Initialize();
    MH_CreateHook(g_Present, &HookedPresent,
        reinterpret_cast<void**>(&oPresent));
    MH_EnableHook(g_Present);

    OutputDebugStringA("[Dx11Hook] Present hook installed\n");

    swapChain->Release();
    context->Release();
    device->Release();

    return 0;
}

// ------------------------------------------------------------
// DLL entry
// ------------------------------------------------------------

BOOL APIENTRY DllMain(
    HMODULE hModule,
    DWORD reason,
    LPVOID
)
{
    if (reason == DLL_PROCESS_ATTACH)
    {
        DisableThreadLibraryCalls(hModule);
        CreateThread(nullptr, 0, WorkerThread, nullptr, 0, nullptr);
    }
    return TRUE;
}

// ------------------------------------------------------------
// Hook — STAGE 2 + STAGE 3
// ------------------------------------------------------------

HRESULT __stdcall HookedPresent(
    IDXGISwapChain* swapChain,
    UINT SyncInterval,
    UINT Flags
)
{
    static bool initialized = false;
    static bool saved = false;

    // Stage 1: get device/context
    if (!initialized)
    {
        if (SUCCEEDED(swapChain->GetDevice(
            __uuidof(ID3D11Device),
            (void**)&g_Device)))
        {
            g_Device->GetImmediateContext(&g_Context);
            OutputDebugStringA(
                "[Dx11Hook] Device + Context acquired\n"
            );
            initialized = true;
        }
    }

    ID3D11Texture2D* backBuffer = nullptr;

    if (SUCCEEDED(swapChain->GetBuffer(
        0,
        __uuidof(ID3D11Texture2D),
        (void**)&backBuffer)))
    {
        if (!g_StagingTexture)
        {
            D3D11_TEXTURE2D_DESC desc{};
            backBuffer->GetDesc(&desc);

            desc.Usage = D3D11_USAGE_STAGING;
            desc.BindFlags = 0;
            desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            desc.MiscFlags = 0;

            g_Device->CreateTexture2D(
                &desc, nullptr, &g_StagingTexture
            );
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
            if (!saved)
            {
                D3D11_TEXTURE2D_DESC desc{};
                backBuffer->GetDesc(&desc);

                SaveBMP(
                    "frame.bmp",
                    (uint8_t*)mapped.pData,
                    desc.Width,
                    desc.Height,
                    mapped.RowPitch
                );

                OutputDebugStringA(
                    "[Dx11Hook] Frame saved to disk\n"
                );
                saved = true;
            }

            g_Context->Unmap(g_StagingTexture, 0);
        }

        backBuffer->Release();
    }

    return oPresent(swapChain, SyncInterval, Flags);
}

// ------------------------------------------------------------
// Dummy window
// ------------------------------------------------------------

LRESULT CALLBACK DummyWndProc(
    HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
    return DefWindowProc(hwnd, msg, wp, lp);
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

// ------------------------------------------------------------
// Dummy device
// ------------------------------------------------------------

bool CreateDummyD3D11Device(
    ID3D11Device** device,
    ID3D11DeviceContext** context)
{
    D3D_FEATURE_LEVEL levels[] = {
        D3D_FEATURE_LEVEL_11_0
    };
    D3D_FEATURE_LEVEL level;

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

// ------------------------------------------------------------
// Dummy swap chain
// ------------------------------------------------------------

IDXGISwapChain* CreateDummySwapChain(
    ID3D11Device* device,
    HWND hwnd)
{
    IDXGIDevice* dxgiDevice;
    IDXGIAdapter* adapter;
    IDXGIFactory* factory;

    device->QueryInterface(
        __uuidof(IDXGIDevice),
        (void**)&dxgiDevice);
    dxgiDevice->GetAdapter(&adapter);
    adapter->GetParent(
        __uuidof(IDXGIFactory),
        (void**)&factory);

    DXGI_SWAP_CHAIN_DESC desc{};
    desc.BufferCount = 2;
    desc.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.OutputWindow = hwnd;
    desc.SampleDesc.Count = 1;
    desc.Windowed = TRUE;

    IDXGISwapChain* swapChain = nullptr;
    factory->CreateSwapChain(device, &desc, &swapChain);

    factory->Release();
    adapter->Release();
    dxgiDevice->Release();

    return swapChain;
}

// ------------------------------------------------------------
// Present extraction
// ------------------------------------------------------------

void ExtractPresent(IDXGISwapChain* swapChain)
{
    void** vtable = *reinterpret_cast<void***>(swapChain);
    g_Present = vtable[8];
}
