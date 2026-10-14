import { describe, expect, test } from 'bun:test'

import { shouldRestartServerForSettings } from '../electron/settings-runtime'
import { normalizeSettings } from '../electron/settings-store'
import type { DesktopSettings } from '../src/types/ipc'

describe('automatic server restart for startup settings', () => {
  test.each<Partial<DesktopSettings>>([
    { serverRuntime: 'node' },
    { host: '0.0.0.0' },
    { verbose: true },
    { showToken: true },
  ])('restarts for changed server settings %j', (update) => {
    const previous = normalizeSettings({})
    const next = normalizeSettings({ ...previous, ...update })
    expect(shouldRestartServerForSettings(previous, next)).toBe(true)
  })

  test.each([
    { mode: 'direct' as const },
    { http_proxy: 'http://127.0.0.1:9876' },
    { https_proxy: 'http://127.0.0.1:9876' },
    { no_proxy: 'localhost' },
  ])('restarts for changed proxy settings %j', (update) => {
    const previous = normalizeSettings({})
    const next = { ...previous, proxy: { ...previous.proxy, ...update } }
    expect(shouldRestartServerForSettings(previous, next)).toBe(true)
  })

  test('keeps the running service for unchanged and desktop-only settings', () => {
    const previous = normalizeSettings({})
    const next = normalizeSettings({
      ...previous,
      language: 'zh',
      theme: 'dark',
      minimizeToTray: true,
      apiHome: 'new-home',
      sqliteDbPath: 'new-database',
      oauthApp: 'opencode',
      enterpriseUrl: 'company.ghe.com',
    })
    expect(shouldRestartServerForSettings(previous, previous)).toBe(false)
    expect(shouldRestartServerForSettings(previous, next)).toBe(false)
  })

  test('ignores listening host whitespace', () => {
    const previous = normalizeSettings({ host: '127.0.0.1' })
    expect(
      shouldRestartServerForSettings(previous, {
        ...previous,
        host: ' 127.0.0.1 ',
      }),
    ).toBe(false)
  })
})
