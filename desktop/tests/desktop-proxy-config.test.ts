import { describe, expect, test } from 'bun:test'

import {
  applyDesktopProxySettingsToEnv,
  applyNoProxyServerOverride,
  hasNoProxyServerSwitch,
  resolveElectronProxyConfigFromSettings,
} from '../electron/electron-proxy-config'
import {
  normalizeProxySettings,
  normalizeSettings,
  setLaunchAtLoginFallback,
} from '../electron/settings-store'
import type { DesktopProxySettings } from '../src/types/ipc'

function createProxySettings(
  overrides: Partial<DesktopProxySettings> = {},
): DesktopProxySettings {
  return {
    mode: 'system',
    http_proxy: 'http://127.0.0.1:8888',
    https_proxy: 'http://127.0.0.1:8888',
    no_proxy: 'localhost,127.0.0.1',
    ...overrides,
  }
}

describe('desktop proxy config', () => {
  test('resolves system and direct Electron proxy modes', () => {
    expect(
      resolveElectronProxyConfigFromSettings(createProxySettings()),
    ).toEqual({ mode: 'system' })
    expect(
      resolveElectronProxyConfigFromSettings(
        createProxySettings({ mode: 'direct' }),
      ),
    ).toEqual({ mode: 'direct' })
  })

  test('formats custom http and https proxy rules with no_proxy bypass rules', () => {
    const config = resolveElectronProxyConfigFromSettings(
      createProxySettings({
        mode: 'custom',
        http_proxy: '127.0.0.1:8888',
        https_proxy: 'https://secure.proxy.example:9443',
        no_proxy: ' localhost, .internal.example, localhost, * ',
      }),
    )

    expect(config).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http=127.0.0.1:8888;https=https://secure.proxy.example:9443',
      proxyBypassRules: 'localhost;*.internal.example;*',
    })
  })

  test('formats socks proxies for custom proxy rules', () => {
    const config = resolveElectronProxyConfigFromSettings(
      createProxySettings({
        mode: 'custom',
        http_proxy: 'socks5://127.0.0.1:1080',
        https_proxy: '',
      }),
    )

    expect(config).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http=socks5://127.0.0.1:1080',
      proxyBypassRules: 'localhost;127.0.0.1',
    })
  })

  test('clears proxy environment variables for direct mode', () => {
    const env: NodeJS.ProcessEnv = {
      ALL_PROXY: 'http://old.proxy:8080',
      all_proxy: 'http://old.proxy:8080',
      HTTP_PROXY: 'http://old.proxy:8080',
      http_proxy: 'http://old.proxy:8080',
      HTTPS_PROXY: 'http://old.proxy:8080',
      https_proxy: 'http://old.proxy:8080',
      NO_PROXY: 'old.local',
      no_proxy: 'old.local',
      OTHER_VALUE: 'keep',
    }

    expect(
      applyDesktopProxySettingsToEnv(
        env,
        createProxySettings({ mode: 'direct' }),
      ),
    ).toBe(false)

    expect(env).toEqual({ OTHER_VALUE: 'keep' })
  })

  test('injects normalized proxy environment variables for custom mode', () => {
    const env: NodeJS.ProcessEnv = {
      ALL_PROXY: 'http://old.proxy:8080',
      OTHER_VALUE: 'keep',
    }

    expect(
      applyDesktopProxySettingsToEnv(
        env,
        createProxySettings({
          mode: 'custom',
          http_proxy: '127.0.0.1:8888',
          https_proxy: 'https://secure.proxy.example:9443',
          no_proxy: 'localhost,127.0.0.1',
        }),
      ),
    ).toBe(true)

    expect(env).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:8888/',
      http_proxy: 'http://127.0.0.1:8888/',
      HTTPS_PROXY: 'https://secure.proxy.example:9443/',
      https_proxy: 'https://secure.proxy.example:9443/',
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
      OTHER_VALUE: 'keep',
    })
  })

  test('detects --no-proxy-server and applies a non-mutating direct override', () => {
    const settings = createProxySettings({ mode: 'custom' })
    const effectiveSettings = applyNoProxyServerOverride(settings, true)

    expect(
      hasNoProxyServerSwitch(['Copilot API.exe', '--no-proxy-server']),
    ).toBe(true)
    expect(hasNoProxyServerSwitch(['Copilot API.exe'])).toBe(false)
    expect(effectiveSettings).toEqual({ ...settings, mode: 'direct' })
    expect(effectiveSettings).not.toBe(settings)
    expect(settings.mode).toBe('custom')
    expect(applyNoProxyServerOverride(settings, false)).toBe(settings)
  })

  test('normalizes missing or invalid mode to system without reading legacy enabled', () => {
    const legacyProxy = {
      enabled: true,
      http_proxy: 'http://legacy.proxy:8080',
      https_proxy: 'http://legacy.proxy:8080',
      no_proxy: 'legacy.local',
    } as unknown as Partial<DesktopProxySettings>
    const invalidModeProxy = {
      mode: 'manual',
      http_proxy: 'http://invalid.proxy:8080',
      https_proxy: 'http://invalid.proxy:8080',
      no_proxy: 'invalid.local',
    } as unknown as Partial<DesktopProxySettings>

    expect(normalizeProxySettings(legacyProxy)).toEqual({
      mode: 'system',
      http_proxy: 'http://legacy.proxy:8080',
      https_proxy: 'http://legacy.proxy:8080',
      no_proxy: 'legacy.local',
    })
    expect(normalizeProxySettings(invalidModeProxy)).toEqual({
      mode: 'system',
      http_proxy: 'http://invalid.proxy:8080',
      https_proxy: 'http://invalid.proxy:8080',
      no_proxy: 'invalid.local',
    })
  })

  test('normalizes desktop settings with proxy mode defaults', () => {
    expect(normalizeSettings(null)).toEqual({
      apiHome: '',
      oauthApp: 'default',
      enterpriseUrl: '',
      lastPort: 4141,
      launchAtLogin: false,
      minimizeToTray: false,
      accountType: 'individual',
      verbose: false,
      showToken: false,
      language: 'auto',
      theme: 'auto',
      proxy: {
        mode: 'system',
        http_proxy: 'http://127.0.0.1:8888',
        https_proxy: 'http://127.0.0.1:8888',
        no_proxy: 'localhost,127.0.0.1',
      },
    })

    expect(
      normalizeSettings({
        apiHome: 'C:/copilot-api',
        oauthApp: 'opencode',
        enterpriseUrl: 'ghe.example.com',
        lastPort: 5151,
        launchAtLogin: true,
        minimizeToTray: true,
        accountType: 'enterprise',
        verbose: true,
        showToken: true,
        language: 'zh',
        proxy: createProxySettings({ mode: 'direct' }),
      }),
    ).toEqual({
      apiHome: 'C:/copilot-api',
      oauthApp: 'opencode',
      enterpriseUrl: 'ghe.example.com',
      lastPort: 5151,
      launchAtLogin: true,
      minimizeToTray: true,
      accountType: 'enterprise',
      verbose: true,
      showToken: true,
      language: 'zh',
      theme: 'auto',
      proxy: createProxySettings({ mode: 'direct' }),
    })
  })

  test('normalizes theme preference with fallback to auto', () => {
    type PartialSettings = Partial<import('../src/types/ipc').DesktopSettings>
    expect(normalizeSettings({ theme: 'dark' }).theme).toBe('dark')
    expect(normalizeSettings({ theme: 'light' }).theme).toBe('light')
    expect(normalizeSettings({ theme: 'auto' }).theme).toBe('auto')
    expect(
      normalizeSettings({ theme: 'unknown' } as unknown as PartialSettings)
        .theme,
    ).toBe('auto')
    expect(normalizeSettings({}).theme).toBe('auto')
    expect(normalizeSettings(null).theme).toBe('auto')
  })

  test('preserves the OS login state when migrating old settings', () => {
    setLaunchAtLoginFallback(true)
    try {
      expect(normalizeSettings({}).launchAtLogin).toBe(true)
      expect(normalizeSettings({ launchAtLogin: false }).launchAtLogin).toBe(
        false,
      )
    } finally {
      setLaunchAtLoginFallback(false)
    }
  })
})
