import type { DesktopSettings } from '../src/types/ipc'

export function shouldRestartServerForSettings(
  previous: DesktopSettings,
  next: DesktopSettings,
): boolean {
  return (
    previous.serverRuntime !== next.serverRuntime
    || previous.host.trim() !== next.host.trim()
    || previous.verbose !== next.verbose
    || previous.showToken !== next.showToken
    || previous.proxy.mode !== next.proxy.mode
    || previous.proxy.http_proxy !== next.proxy.http_proxy
    || previous.proxy.https_proxy !== next.proxy.https_proxy
    || previous.proxy.no_proxy !== next.proxy.no_proxy
  )
}
