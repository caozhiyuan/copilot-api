import type {
  AuthStatus,
  DesktopAuthMode,
  DesktopSettings,
  ServerStatus,
} from '../types/ipc'

export async function autoStartServer(
  settings: Pick<DesktopSettings, 'autoStartServer' | 'lastPort'>,
  authStatus: AuthStatus,
  startServer: (
    port: number,
    authMode?: DesktopAuthMode,
  ) => Promise<ServerStatus>,
): Promise<ServerStatus | undefined> {
  if (
    !settings.autoStartServer
    || !authStatus.success
    || authStatus.mode === 'none'
  ) {
    return
  }

  try {
    return await startServer(settings.lastPort, authStatus.mode)
  } catch (error) {
    return {
      running: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
