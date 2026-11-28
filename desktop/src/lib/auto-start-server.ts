import type {
  AuthStatus,
  DesktopAuthMode,
  DesktopSettings,
  ServerStatus,
} from '../types/ipc'

export async function autoStartServer(
  settings: Pick<DesktopSettings, 'autoStartServer' | 'lastPort' | 'host'>,
  authStatus: AuthStatus,
  startServer: (
    port: number,
    authMode?: DesktopAuthMode,
    host?: string,
  ) => Promise<ServerStatus>,
  getServerStatus?: () => Promise<ServerStatus>,
): Promise<ServerStatus | undefined> {
  if (
    !settings.autoStartServer
    || !authStatus.success
    || authStatus.mode === 'none'
  ) {
    return
  }

  try {
    const currentStatus = await getServerStatus?.().catch(() => undefined)
    if (currentStatus?.running) return currentStatus
    return await startServer(settings.lastPort, authStatus.mode, settings.host)
  } catch (error) {
    return {
      running: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
