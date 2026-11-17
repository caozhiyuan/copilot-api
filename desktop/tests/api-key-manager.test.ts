import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act, createElement } from 'react'
import { createTestDom } from './helpers/dom'
import ApiKeyManager from '../src/components/ApiKeyManager'
import { LanguageProvider } from '../src/contexts/LanguageContext'
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
async function render() {
  await act(async () => {
    dom.root.render(
      createElement(LanguageProvider, {
        children: createElement(ApiKeyManager),
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
    dom.container.querySelector<HTMLInputElement>('[aria-label="Expires at"]')
      ?.value,
  ).toHaveLength(16)
  await type('Allowed models', 'custom/model\ncustom/model')
  await type('Expires at', '2031-01-02T12:30')
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
