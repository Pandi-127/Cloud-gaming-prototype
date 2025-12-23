#include <windows.h>
#include <tlhelp32.h>
#include <iostream>

DWORD FindProcessId(const wchar_t* processName)
{
    PROCESSENTRY32W processEntry{};
    processEntry.dwSize = sizeof(processEntry);

    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE)
        return 0;

    if (Process32FirstW(snapshot, &processEntry))
    {
        do
        {
            if (_wcsicmp(processEntry.szExeFile, processName) == 0)
            {
                CloseHandle(snapshot);
                return processEntry.th32ProcessID;
            }
        } while (Process32NextW(snapshot, &processEntry));
    }

    CloseHandle(snapshot);
    return 0;
}

int main()
{
    const wchar_t* targetProcess = L"EmptyProject11.exe";
    const wchar_t* dllPath = L"D:\\Projects\\Cloud-Gaming-Prototype\\dll\\Dx11Hook\\x64\\Debug\\Dx11Hook.dll";

    DWORD pid = FindProcessId(targetProcess);
    if (pid == 0)
    {
        std::cout << "Target process not found\n";
        return 1;
    }

    HANDLE hProcess = OpenProcess(
        PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
        PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ,
        FALSE,
        pid
    );

    if (!hProcess)
    {
        std::cout << "Failed to open process\n";
        return 1;
    }

    size_t pathSize = (wcslen(dllPath) + 1) * sizeof(wchar_t);

    LPVOID remoteMemory = VirtualAllocEx(
        hProcess,
        nullptr,
        pathSize,
        MEM_COMMIT | MEM_RESERVE,
        PAGE_READWRITE
    );

    if (!remoteMemory)
    {
        std::cout << "VirtualAllocEx failed\n";
        CloseHandle(hProcess);
        return 1;
    }

    WriteProcessMemory(
        hProcess,
        remoteMemory,
        dllPath,
        pathSize,
        nullptr
    );

    HMODULE hKernel32 = GetModuleHandleW(L"kernel32.dll");
    FARPROC loadLibraryAddr = GetProcAddress(hKernel32, "LoadLibraryW");

    HANDLE hThread = CreateRemoteThread(
        hProcess,
        nullptr,
        0,
        (LPTHREAD_START_ROUTINE)loadLibraryAddr,
        remoteMemory,
        0,
        nullptr
    );

    if (!hThread)
    {
        std::cout << "CreateRemoteThread failed\n";
        VirtualFreeEx(hProcess, remoteMemory, 0, MEM_RELEASE);
        CloseHandle(hProcess);
        return 1;
    }

    WaitForSingleObject(hThread, INFINITE);

    VirtualFreeEx(hProcess, remoteMemory, 0, MEM_RELEASE);
    CloseHandle(hThread);
    CloseHandle(hProcess);

    std::cout << "DLL injected successfully\n";
    return 0;
}
