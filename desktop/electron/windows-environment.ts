export type WindowsEnvironmentNotifier = () => Promise<boolean>

interface SendMessageTimeout {
  async: (
    window: number,
    message: number,
    wParam: number,
    area: string,
    flags: number,
    timeout: number,
    result: null,
    callback: (error: unknown, result: number) => void,
  ) => void
}

interface NativeLibrary {
  func: (definition: string) => SendMessageTimeout
}

const HWND_BROADCAST = 0xffff
const WM_SETTINGCHANGE = 0x001a
const SMTO_ABORTIFHUNG = 0x0002
const SMTO_ERRORONEXIT = 0x0020
const WINDOW_TIMEOUT_MS = 1000
const BROADCAST_TIMEOUT_MS = 2000

function notificationError(error: unknown): Error {
  return error instanceof Error ? error : (
      new Error('Native environment notification failed')
    )
}

// Loading is deferred until a Windows write, and shared by later writes.
export function createWindowsEnvironmentNotifierLoader(
  loadLibrary: () => Promise<NativeLibrary> = async () =>
    (await import('koffi')).load('user32.dll'),
): () => Promise<WindowsEnvironmentNotifier> {
  let pending: Promise<WindowsEnvironmentNotifier> | undefined
  return () => {
    pending ??= loadLibrary()
      .then((library) => {
        const send = library.func(
          'intptr_t __stdcall SendMessageTimeoutW(uintptr_t window, uint32_t message, uintptr_t wParam, str16 area, uint32_t flags, uint32_t timeout, uintptr_t *result)',
        )
        return () =>
          new Promise<boolean>((resolve, reject) => {
            // The Win32 timeout applies per window. Bound the caller's entire
            // wait as well; Koffi retains native arguments until its callback.
            const timer = setTimeout(() => resolve(false), BROADCAST_TIMEOUT_MS)
            try {
              send.async(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                'Environment',
                SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT,
                WINDOW_TIMEOUT_MS,
                null,
                (error, result) => {
                  clearTimeout(timer)
                  if (error) reject(notificationError(error))
                  else resolve(result !== 0)
                },
              )
            } catch (error) {
              clearTimeout(timer)
              reject(notificationError(error))
            }
          })
      })
      .catch((error: unknown) => {
        pending = undefined
        throw error
      })
    return pending
  }
}

export const loadWindowsEnvironmentNotifier =
  createWindowsEnvironmentNotifierLoader()
