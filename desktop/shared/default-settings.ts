import type { DesktopSettings } from '../src/types/ipc'

export function createDefaultSettings(): DesktopSettings {
  return {
    serverRuntime: 'bun',
    apiHome: '',
    sqliteDbPath: '',
    oauthApp: 'default',
    enterpriseUrl: '',
    host: '',
    lastPort: 4141,
    launchAtLogin: false,
    autoStartServer: false,
    minimizeToTray: false,
    accountType: 'individual',
    verbose: false,
    showToken: false,
    showCreate: false,
    language: 'auto',
    theme: 'auto',
    proxy: {
      mode: 'system',
      http_proxy: 'http://127.0.0.1:8888',
      https_proxy: 'http://127.0.0.1:8888',
      no_proxy: 'localhost,127.0.0.1',
    },
  }
}
