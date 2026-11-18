import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act, createElement, useEffect } from 'react'
import { createTestDom } from './helpers/dom'
import ApiKeyManager from '../src/components/ApiKeyManager'
import { LanguageProvider, useLanguage } from '../src/contexts/LanguageContext'
import type { LangPreference } from '../src/locales'
import type {
  GatewayApiKeyConfig,
  ServerKeysConfig,
  ServerKeysConfigUpdate,
} from '../src/types/ipc'

let dom: Awaited<ReturnType<typeof createTestDom>>
let keys: GatewayApiKeyConfig[]
let auth: ServerKeysConfig
let saveAuth: ReturnType<
  typeof mock<(update: ServerKeysConfigUpdate) => Promise<ServerKeysConfig>>
>
let save: ReturnType<
  typeof mock<(key: GatewayApiKeyConfig) => Promise<GatewayApiKeyConfig[]>>
>
let remove: ReturnType<
  typeof mock<(id: string) => Promise<GatewayApiKeyConfig[]>>
>
beforeEach(async () => {
  dom = await createTestDom()
  keys = [
    {
      id: 'stable',
      key: 'sk-original-secret',
      name: 'Alice',
      allowedModels: ['codex/*'],
      quota: { period: 'month', amount: 1000 },
    },
  ]
  save = mock((key: GatewayApiKeyConfig) => {
    keys = [key]
    return Promise.resolve(keys)
  })
  remove = mock((_id: string) => {
    keys = []
    return Promise.resolve(keys)
  })
  auth = { apiKeys: ['sk-original-secret'], adminApiKey: 'fixture-admin' }
  saveAuth = mock((update: ServerKeysConfigUpdate) => {
    auth = { ...auth, ...update, adminApiKey: auth.adminApiKey }
    return Promise.resolve(auth)
  })
  Object.defineProperty(dom.win, 'electronAPI', {
    configurable: true,
    value: {
      getManagedApiKeys: () => Promise.resolve(keys),
      getServerKeys: () => Promise.resolve(auth),
      saveServerKeys: saveAuth,
      getApiKeyQuotaUsage: () =>
        Promise.resolve([
          {
            id: 'stable',
            usedAmount: 250,
            remainingAmount: 750,
            resetsAt: null,
          },
        ]),
      saveManagedApiKey: save,
      removeManagedApiKey: remove,
    },
  })
  Object.defineProperty(dom.win, 'confirm', {
    configurable: true,
    value: () => true,
  })
})
afterEach(async () => {
  await act(async () => dom.root.unmount())
  await dom.cleanup()
})
function LocalizedApiKeys({ language }: { language: LangPreference }) {
  const { setLangPref } = useLanguage()
  useEffect(() => setLangPref(language), [language, setLangPref])
  return createElement(ApiKeyManager)
}
async function render(language: LangPreference = 'auto') {
  await act(async () => {
    dom.root.render(
      createElement(LanguageProvider, {
        children: createElement(LocalizedApiKeys, { language }),
      }),
    )
  })
}
async function click(text: string) {
  const button = [...dom.container.querySelectorAll('button')].find(
    (button) => button.textContent === text,
  )
  if (!button) throw new Error('Missing button: ' + text)
  await act(async () => button.click())
}
async function clickLabel(label: string) {
  const button = dom.container.querySelector<HTMLButtonElement>(
    'button[aria-label="' + label + '"]',
  )
  if (!button) throw new Error('Missing button: ' + label)
  await act(async () => button.click())
}
async function type(label: string, text: string) {
  const input = dom.container.querySelector<
    HTMLInputElement | HTMLTextAreaElement
  >('[aria-label="' + label + '"]')
  if (!input) throw new Error('Missing field: ' + label)
  await act(async () => {
    const prototype =
      input instanceof HTMLInputElement ?
        HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
test('shows masked keys and current quota and preserves identity during rotation', async () => {
  await render()
  expect(dom.container.textContent).toContain('Alice')
  expect(dom.container.textContent).toContain('250')
  expect(dom.container.textContent).toContain('750')
  expect(dom.container.textContent).not.toContain('sk-original-secret')
  await click('Edit')
  await type('Name', 'Renamed')
  await click('Rotate key')
  const secret =
    dom.container.querySelector<HTMLInputElement>('[aria-label="Key"]')?.value
  expect(secret).toMatch(/^sk-[0-9a-f]{64}$/)
  await click('Save key')
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    id: 'stable',
    key: secret,
    name: 'Renamed',
    allowedModels: ['codex/*'],
    quota: { period: 'month', amount: 1000 },
  })
})
test('creates an unrestricted unlimited key and deletes only the selected identity', async () => {
  await render()
  await click('Add key')
  await click('Save key')
  expect(save.mock.calls[0]?.[0].quota).toBeUndefined()
  expect(save.mock.calls[0]?.[0].allowedModels).toBeUndefined()
  expect(save.mock.calls[0]?.[0].id).toMatch(/^key_/)
  await click('Delete')
  expect(remove).toHaveBeenCalledWith(keys[0]?.id ?? save.mock.calls[0]?.[0].id)
  expect(dom.container.textContent).toContain('No API keys configured.')
})
test('retains an explicit empty model allowlist and zero quota', async () => {
  keys = [
    {
      id: 'stable',
      key: 'secret',
      allowedModels: [],
      quota: { period: 'lifetime', amount: 0 },
    },
  ]
  await render()
  await click('Edit')
  await click('Save key')
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    allowedModels: [],
    quota: { period: 'lifetime', amount: 0 },
  })
})
test('keeps an editable draft after a save or refresh failure', async () => {
  save.mockRejectedValueOnce(new Error('refresh failed'))
  await render()
  await click('Edit')
  await click('Save key')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain(
    'refresh failed',
  )
  expect(dom.container.querySelector('form')).not.toBeNull()
  await click('Cancel')
  expect(dom.container.querySelector('form')).toBeNull()
})

test('edits model restrictions, expiration, enablement and quota fields', async () => {
  keys[0].expiresAt = '2030-01-01T00:00:00.000Z'
  await render()
  await click('Edit')
  expect(
    dom.container.querySelector<HTMLInputElement>(
      '[aria-label="Expiration date"]',
    )?.value,
  ).toHaveLength(10)
  await type('Allowed models', 'custom/model\ncustom/model')
  await type('Expiration date', '2031-01-02')
  await type('Expiration time (local)', '12:30')
  const checkbox = dom.container.querySelector<HTMLInputElement>(
    'input[type="checkbox"]:not([role="switch"])',
  )
  if (!checkbox) throw new Error('Missing enabled checkbox')
  const select = dom.container.querySelector<HTMLSelectElement>(
    '[aria-label="Spending limit (USD)"]',
  )
  if (!select) throw new Error('Missing quota period')
  await act(async () => {
    checkbox.click()
    select.value = 'day'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await type('Amount (USD)', '0.125')
  await click('Save key')
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    id: 'stable',
    enabled: false,
    allowedModels: ['custom/model'],
    quota: { period: 'day', amount: 0.125 },
  })
  expect(save.mock.calls[0]?.[0].expiresAt).toBe(
    new Date('2031-01-02T12:30').toISOString(),
  )
})
test('switches expiration calendar language with the app on a Chinese system', async () => {
  Object.defineProperty(dom.win.navigator, 'language', {
    configurable: true,
    value: 'zh-CN',
  })
  keys[0].expiresAt = new Date('2030-01-20T12:30').toISOString()
  await render('zh')
  await click('编辑')
  await clickLabel('选择过期日期')
  const calendar = () => dom.container.querySelector('[role="dialog"]')
  expect(calendar()?.textContent).toContain('2030年1月')
  await render('en')
  expect(calendar()?.textContent).toContain('January 2030')
  expect(calendar()?.textContent).toContain('Sun')
  expect(calendar()?.textContent).not.toContain('周')
  await clickLabel('Previous month')
  expect(calendar()?.textContent).toContain('December 2029')
  await clickLabel('Next month')
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    )
  })
  expect(document.activeElement?.getAttribute('aria-label')).toBe(
    'January 2, 2030',
  )
  await clickLabel('January 2, 2030')
  expect(calendar()).toBeNull()
  await click('Save key')
  expect(save.mock.calls[0]?.[0].expiresAt).toBe(
    new Date('2030-01-02T12:30').toISOString(),
  )
})
test('preserves an untouched expiration and rejects invalid dates before saving', async () => {
  const expiresAt = new Date('2030-01-20T12:30:42').toISOString()
  keys[0].expiresAt = expiresAt
  await render()
  await click('Edit')
  await click('Save key')
  expect(save.mock.calls[0]?.[0].expiresAt).toBe(expiresAt)
  await click('Edit')
  await type('Expiration date', '2030-02-30')
  await click('Save key')
  expect(save).toHaveBeenCalledTimes(1)
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain(
    'Enter a valid date and time',
  )
  await click('Clear expiry')
  await click('Save key')
  expect(save.mock.calls[1]?.[0].expiresAt).toBeUndefined()
})
test('handles copy failure, cancelled deletion and deletion failure', async () => {
  Object.defineProperty(dom.win.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.reject(new Error('unavailable')) },
  })
  await render()
  await click('Copy')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not save',
  )
  Object.defineProperty(dom.win, 'confirm', {
    configurable: true,
    value: () => false,
  })
  await click('Delete')
  expect(remove).not.toHaveBeenCalled()
  Object.defineProperty(dom.win, 'confirm', {
    configurable: true,
    value: () => true,
  })
  remove.mockRejectedValueOnce(new Error('refresh failed'))
  await click('Delete')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain(
    'refresh failed',
  )
})
test('reports a key loading failure without displaying a secret', async () => {
  window.electronAPI.getManagedApiKeys = () =>
    Promise.reject(new Error('disk error'))
  window.electronAPI.getApiKeyQuotaUsage = () =>
    Promise.reject(new Error('offline'))
  await render()
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not load API keys',
  )
  expect(dom.container.textContent).toContain('Start the service')
  expect(dom.container.textContent).not.toContain('sk-original-secret')
})

test('defaults to shared history and saves only the usage isolation switch', async () => {
  await render()
  const toggle =
    dom.container.querySelector<HTMLInputElement>('[role="switch"]')!
  expect(toggle.checked).toBe(false)
  expect(toggle.disabled).toBe(false)
  await act(async () => toggle.click())
  expect(saveAuth).toHaveBeenCalledWith({ isolateApiKeyUsage: true })
  expect(toggle.checked).toBe(true)
  expect(auth.apiKeys).toEqual(['sk-original-secret'])
  expect(auth.adminApiKey).toBe('fixture-admin')
  await act(async () => toggle.click())
  expect(saveAuth).toHaveBeenLastCalledWith({ isolateApiKeyUsage: false })
  expect(toggle.checked).toBe(false)
  expect(save).not.toHaveBeenCalled()
})

test('loads persisted isolation and preserves it on a save failure', async () => {
  auth.isolateApiKeyUsage = true
  saveAuth.mockRejectedValueOnce(new Error('refresh failed'))
  await render()
  const toggle =
    dom.container.querySelector<HTMLInputElement>('[role="switch"]')!
  expect(toggle.checked).toBe(true)
  await act(async () => toggle.click())
  expect(toggle.checked).toBe(true)
  expect(toggle.disabled).toBe(false)
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain(
    'refresh failed',
  )
})
