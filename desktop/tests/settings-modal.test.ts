import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

import SettingsModal from '../src/components/SettingsModal'
import Header from '../src/components/Header'
import AuthPage from '../src/pages/AuthPage'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import { ThemeProvider } from '../src/contexts/ThemeContext'
import type {
  DesktopSettings,
  AppUpdateStatus,
  ServerKeysConfig,
  ServerKeysConfigUpdate,
} from '../src/types/ipc'

const initialSettings: DesktopSettings = {
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
  language: 'en',
  theme: 'light',
  proxy: {
    mode: 'system',
    http_proxy: 'http://127.0.0.1:8888',
    https_proxy: 'http://127.0.0.1:8888',
    no_proxy: 'localhost,127.0.0.1',
  },
}
let settings: DesktopSettings
let keys: ServerKeysConfig
let win: Window
let container: HTMLDivElement
let root: Root
let saveSettings: ReturnType<
  typeof mock<typeof window.electronAPI.saveSettings>
>
let saveServerKeys: ReturnType<
  typeof mock<typeof window.electronAPI.saveServerKeys>
>
let alert: ReturnType<typeof mock<(message: string) => void>>
let onClose: ReturnType<typeof mock<() => void>>
const previousGlobals = new Map<string, PropertyDescriptor | undefined>()

function persistKeys(update: ServerKeysConfigUpdate): ServerKeysConfig {
  keys = {
    apiKeys: update.apiKeys ?? keys.apiKeys,
    adminApiKey: update.adminApiKey ?? keys.adminApiKey,
  }
  return structuredClone(keys)
}

beforeEach(async () => {
  settings = structuredClone(initialSettings)
  keys = { apiKeys: ['old-api'], adminApiKey: 'old-admin' }
  win = new Window({ url: 'http://localhost' })
  const globals: Record<string, unknown> = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    Event: win.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [name, value] of Object.entries(globals)) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    })
  }
  saveSettings = mock((update: DesktopSettings) => {
    settings = structuredClone(update)
    return Promise.resolve()
  })
  saveServerKeys = mock((update: ServerKeysConfigUpdate) =>
    Promise.resolve(persistKeys(update)),
  )
  alert = mock((_message: string) => {})
  onClose = mock(() => {})
  Object.defineProperty(win, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'win32',
      getSettings: () => Promise.resolve(structuredClone(settings)),
      getBunRuntime: () =>
        Promise.resolve({
          available: true,
          version: '1.4.0',
          path: '/usr/local/bin/bun',
        }),
      getServerKeys: () => Promise.resolve(structuredClone(keys)),
      saveSettings,
      saveServerKeys,
    },
  })
  Object.defineProperty(win, 'alert', { configurable: true, value: alert })
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  await win.happyDOM.close()
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  previousGlobals.clear()
})

async function render() {
  await act(async () => {
    root.render(
      createElement(LanguageProvider, {
        children: createElement(ThemeProvider, {
          children: createElement(SettingsModal, { onClose }),
        }),
      }),
    )
  })
}

async function renderHeader(onChangeAuth = () => {}) {
  const initial: AppUpdateStatus = {
    phase: 'idle',
    currentVersion: '2.6.31',
    manualInstall: false,
    releaseUrl: 'https://github.com/caozhiyuan/copilot-api/releases',
  }
  Object.assign(window.electronAPI, {
    windowIsMaximized: () => Promise.resolve(false),
    onWindowMaximizeChange: () => () => {},
    getAppUpdateStatus: () => Promise.resolve(initial),
    onAppUpdateStatus: () => () => {},
  })
  await act(async () => {
    root.render(
      createElement(LanguageProvider, {
        children: createElement(ThemeProvider, {
          children: createElement(Header, { onChangeAuth }),
        }),
      }),
    )
  })
}

describe('desktop menu shortcuts', () => {
  test('opens updates from Help, checks immediately, and shows the result', async () => {
    const check = mock(() =>
      Promise.resolve({
        phase: 'not-available' as const,
        currentVersion: '2.6.31',
        manualInstall: false,
        releaseUrl: 'https://github.com/caozhiyuan/copilot-api/releases',
      }),
    )
    Object.assign(window.electronAPI, { checkAppUpdate: check })
    await renderHeader()
    await click('Help')
    await click('Check for updates')
    expect(check).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain(
      'No newer release is available for this platform',
    )
    expect(container.querySelector('input')).toBeNull()
    expect(saveSettings).not.toHaveBeenCalled()
    expect(saveServerKeys).not.toHaveBeenCalled()
    await click('Cancel')
    await click('File')
    await click('Settings')
    expect(container.querySelector('select')).not.toBeNull()
    expect(check).toHaveBeenCalledTimes(1)
  })

  test('shows an update check failure and allows a retry', async () => {
    const check = mock(() => Promise.reject(new Error('offline')))
    Object.assign(window.electronAPI, { checkAppUpdate: check })
    await renderHeader()
    await click('Help')
    await click('Check for updates')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not complete the update action',
    )
    await click('Check for updates')
    expect(check).toHaveBeenCalledTimes(2)
  })

  test('opens existing authorization configuration from File', async () => {
    const changeAuth = mock(() => {})
    await renderHeader(changeAuth)
    await click('File')
    await click('Auth config')
    expect(changeAuth).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('Auth config')
    expect(saveSettings).not.toHaveBeenCalled()
    expect(saveServerKeys).not.toHaveBeenCalled()
  })

  test('returns to authorization choices when already on the authorization page', async () => {
    await renderHeader()
    await act(async () => {
      root.render(
        createElement(LanguageProvider, {
          children: createElement(ThemeProvider, {
            children: createElement(AuthPage, { onSuccess: () => {} }),
          }),
        }),
      )
    })
    await click('Enter Copilot token manually')
    expect(container.querySelector('textarea')).not.toBeNull()
    await click('File')
    await click('Auth config')
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.textContent).toContain('Enter Copilot token manually')
  })
})

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === label,
  )
  if (!button) throw new Error(`Missing button: ${label}`)
  await act(async () => button.click())
}

async function changeText(
  node: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    const prototype =
      node instanceof HTMLInputElement ?
        HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function changePreferences() {
  await click('Dark')
  const select = container.querySelector('select')
  if (!select) throw new Error('Missing language selector')
  await act(async () => {
    select.value = 'zh'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function changeAdminKey() {
  await click('Security')
  const input = container.querySelector<HTMLInputElement>('input[type="text"]')
  if (!input) throw new Error('Missing admin key input')
  await changeText(input, 'new-admin')
}

describe('settings modal partial saves', () => {
  test('shows detected Bun and saves an explicit Node runtime selection', async () => {
    await render()
    await click('Startup')
    const select = container.querySelector<HTMLSelectElement>('#server-runtime')
    expect(select?.value).toBe('bun')
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Bun 1.4.0 detected',
    )
    if (!select) throw new Error('Missing runtime selector')
    await act(async () => {
      select.value = 'node'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click('Save')
    expect(settings.serverRuntime).toBe('node')
    expect(alert).not.toHaveBeenCalled()
  })

  test('explains fallback for an unsupported Bun version', async () => {
    window.electronAPI.getBunRuntime = () =>
      Promise.resolve({ available: false, version: '1.3.14' })
    await render()
    await click('Startup')
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Bun 1.3.14 is unsupported',
    )
    await click('Save')
    expect(settings.serverRuntime).toBe('bun')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('keeps settings usable when Bun detection fails', async () => {
    window.electronAPI.getBunRuntime = () =>
      Promise.reject(new Error('unavailable'))
    await render()
    await click('Startup')
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Bun >= 1.4.0 was not found',
    )
  })

  test('saves show create from general settings', async () => {
    await render()
    const toggle = [...container.querySelectorAll('button')].find(
      (node) =>
        node.getAttribute('role') === 'switch'
        && node.parentElement?.textContent?.includes('Show create'),
    )
    if (!toggle) throw new Error('Missing show create switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await act(async () => {
      toggle.click()
    })
    await click('Save')
    expect(settings.showCreate).toBe(true)
  })

  test('saves desktop preferences when persisted keys fail to refresh', async () => {
    saveServerKeys.mockImplementationOnce((update) => {
      persistKeys(update)
      return Promise.reject(
        new Error('Configuration saved, but refresh failed: Unauthorized'),
      )
    })
    await render()
    await changePreferences()
    await changeAdminKey()
    await click('Save')
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'dark', language: 'zh' }),
    )
    expect(settings.theme).toBe('dark')
    expect(settings.language).toBe('zh')
    expect(keys.adminApiKey).toBe('new-admin')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert.mock.calls[0]?.[0]).toContain(
      'Server key saving or refresh failed',
    )
    expect(alert.mock.calls[0]?.[0]).toContain('Unauthorized')
    expect(onClose).not.toHaveBeenCalled()
  })

  test('saves desktop preferences even when writing keys fails', async () => {
    saveServerKeys.mockRejectedValueOnce(new Error('disk full'))
    await render()
    await changePreferences()
    await changeAdminKey()
    await click('Save')
    expect(settings.theme).toBe('dark')
    expect(settings.language).toBe('zh')
    expect(keys.adminApiKey).toBe('old-admin')
    expect(container.querySelector<HTMLInputElement>('input')?.value).toBe(
      'old-admin',
    )
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(alert.mock.calls[0]?.[0]).toContain('disk full')
  })

  test('saves listening and proxy settings after a key refresh failure', async () => {
    saveServerKeys.mockImplementationOnce((update) => {
      persistKeys(update)
      return Promise.reject(new Error('key refresh failed'))
    })
    await render()
    await click('Network')
    await click('Custom proxy')
    const inputs = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="text"]'),
    ]
    if (inputs.length !== 4) throw new Error('Missing network inputs')
    await changeText(inputs[0], '0.0.0.0')
    await changeText(inputs[1], 'http://127.0.0.1:9876')
    await changeText(inputs[2], 'http://127.0.0.1:9877')
    await changeText(inputs[3], 'localhost,127.0.0.1,example.com')
    await changeAdminKey()
    await click('Save')
    expect(settings.host).toBe('0.0.0.0')
    expect(settings.proxy).toEqual({
      mode: 'custom',
      http_proxy: 'http://127.0.0.1:9876',
      https_proxy: 'http://127.0.0.1:9877',
      no_proxy: 'localhost,127.0.0.1,example.com',
    })
    expect(alert.mock.calls[0]?.[0]).toContain('key refresh failed')
    expect(onClose).not.toHaveBeenCalled()
  })

  test('reports both refresh errors after attempting both saves', async () => {
    saveServerKeys.mockImplementationOnce((update) => {
      persistKeys(update)
      return Promise.reject(new Error('key refresh failed'))
    })
    saveSettings.mockImplementationOnce((update) => {
      settings = structuredClone(update)
      return Promise.reject(new Error('settings refresh failed'))
    })
    await render()
    await changePreferences()
    await changeAdminKey()
    await click('Save')
    expect(saveServerKeys).toHaveBeenCalledTimes(1)
    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(keys.adminApiKey).toBe('new-admin')
    expect(settings.theme).toBe('dark')
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert.mock.calls[0]?.[0]).toContain(
      'Server key saving or refresh failed: key refresh failed',
    )
    expect(alert.mock.calls[0]?.[0]).toContain(
      'Desktop settings saving or service refresh failed: settings refresh failed',
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  test('keeps desktop-only changes after their service refresh fails', async () => {
    saveSettings.mockImplementationOnce((update) => {
      settings = structuredClone(update)
      return Promise.reject(new Error('service unavailable'))
    })
    await render()
    await changePreferences()
    await click('Save')
    expect(saveServerKeys).not.toHaveBeenCalled()
    expect(settings.theme).toBe('dark')
    expect(settings.language).toBe('zh')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(alert.mock.calls[0]?.[0]).toContain(
      'Desktop settings saving or service refresh failed',
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  test('closes normally after both saves succeed', async () => {
    await render()
    await changePreferences()
    await changeAdminKey()
    await click('Save')
    expect(saveServerKeys).toHaveBeenCalledWith({ adminApiKey: 'new-admin' })
    expect(keys.adminApiKey).toBe('new-admin')
    expect(settings.theme).toBe('dark')
    expect(settings.language).toBe('zh')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(alert).not.toHaveBeenCalled()
  })

  test('leaves the admin key out of an API-key-only update', async () => {
    await render()
    await click('Security')
    const textarea = container.querySelector('textarea')
    if (!textarea) throw new Error('Missing API key input')
    await changeText(textarea, 'new-api')
    await click('Save')
    expect(saveServerKeys).toHaveBeenCalledWith({ apiKeys: ['new-api'] })
    expect(keys.adminApiKey).toBe('old-admin')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('leaves server keys untouched for desktop-only saves', async () => {
    await render()
    await changePreferences()
    await click('Save')
    expect(saveServerKeys).not.toHaveBeenCalled()
    expect(settings.theme).toBe('dark')
    expect(settings.language).toBe('zh')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(alert).not.toHaveBeenCalled()
  })

  test('still prompts for an app restart after saving startup settings', async () => {
    await render()
    await click('Startup')
    const input =
      container.querySelector<HTMLInputElement>('input[type="text"]')
    if (!input) throw new Error('Missing API Home input')
    await changeText(input, 'new-api-home')
    await click('Save')
    expect(settings.apiHome).toBe('new-api-home')
    expect(alert.mock.calls[0]?.[0]).toContain('Restart the app')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
