/* A small Win32 GUI program used to check the Windows backend.
 * It avoids the C runtime entirely (no msvcrt/UCRT import), like many classic Win32 programs:
 *   i686-w64-mingw32-gcc -Os -s -mwindows -nostdlib -e _WinMainCRTStartup -o hello.exe hello.c \
 *     -lkernel32 -luser32 -lgdi32 */
#include <windows.h>

static int clicks = 0;
static HWND label;

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
  switch (msg) {
    case WM_CREATE:
      label = CreateWindowA("STATIC", "Hello from webapp-anything!\nThis Windows program runs in your browser.",
                            WS_CHILD | WS_VISIBLE | SS_CENTER, 20, 30, 360, 60, hwnd, NULL, NULL, NULL);
      CreateWindowA("BUTTON", "Click me", WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON, 140, 110, 120, 32, hwnd,
                    (HMENU)1, NULL, NULL);
      return 0;
    case WM_COMMAND:
      if (LOWORD(wParam) == 1) {
        char text[96];
        clicks++;
        wsprintfA(text, "Hello from webapp-anything!\nButton clicked %d time%s.", clicks, clicks == 1 ? "" : "s");
        SetWindowTextA(label, text);
      }
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcA(hwnd, msg, wParam, lParam);
}

int WINAPI WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmd, int show) {
  WNDCLASSA wc = {0};
  MSG msg;
  (void)prev;
  (void)cmd;
  wc.lpfnWndProc = WndProc;
  wc.hInstance = inst;
  wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
  wc.lpszClassName = "WaaHello";
  RegisterClassA(&wc);
  HWND hwnd = CreateWindowA("WaaHello", "Hello (Win32)", WS_OVERLAPPEDWINDOW & ~WS_THICKFRAME, 120, 100, 400, 200,
                            NULL, NULL, inst, NULL);
  ShowWindow(hwnd, show);
  UpdateWindow(hwnd);
  while (GetMessageA(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageA(&msg);
  }
  return (int)msg.wParam;
}

/* Entry point without the C runtime. */
void WINAPI WinMainCRTStartup(void) {
  ExitProcess((UINT)WinMain(GetModuleHandleA(NULL), NULL, GetCommandLineA(), SW_SHOWDEFAULT));
}
