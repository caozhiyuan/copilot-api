import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import AdvancedConfigPage from '../src/pages/AdvancedConfigPage'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import type {
  AppConfigDocument,
  AppConfigSaveResult,
  AppConfigUpdate,
} from '../src/types/ipc'
import { defaultConfig } from '../../src/lib/config-store'

let win: Window
let root: Root
let container: HTMLDivElement
let documentFixture: AppConfigDocument
let read: ReturnType<typeof mock<() => Promise<AppConfigDocument>>>
let save: ReturnType<
  typeof mock<(input: AppConfigUpdate) => Promise<AppConfigSaveResult>>
>
let apply: ReturnType<
  typeof mock<(revision: string) => Promise<AppConfigSaveResult>>
>
const previousGlobals = new Map<string, PropertyDescriptor | undefined>()

beforeEach(async () => {
  win = new Window({ url: 'http://localhost' })
  const globals: Record<string, unknown> = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    Event: win.Event,
    MouseEvent: win.MouseEvent,
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
  documentFixture = {
    configPath: '/custom-api-home/config.json',
    revision: 'initial-revision',
    content: JSON.stringify({
      useMessagesApi: true,
      auth: { adminApiKey: 'test-admin-key', apiKeys: ['test-gateway-key'] },
      providers: { custom: { apiKey: 'test-provider-key' } },
      future: { keep: true },
    }),
    defaultContent: JSON.stringify({
      ...defaultConfig,
      claudeTokenMultiplier: 1.15,
    }),
  }
  read = mock(() => Promise.resolve(structuredClone(documentFixture)))
  save = mock((input: AppConfigUpdate) => {
    documentFixture = {
      ...documentFixture,
      ...input,
      revision: 'saved-revision',
    }
    return Promise.resolve({ ...documentFixture, saved: true, applied: false })
  })
  apply = mock((_revision: string) =>
    Promise.resolve({ ...documentFixture, saved: true, applied: true }),
  )
  Object.defineProperty(win, 'electronAPI', {
    configurable: true,
    value: { getAppConfig: read, saveAppConfig: save, applyAppConfig: apply },
  })
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
async function render(serverRunning = false) {
  await act(async () =>
    root.render(
      createElement(LanguageProvider, {
        children: createElement(AdvancedConfigPage, { serverRunning }),
      }),
    ),
  )
}
function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(
    (el) => el.textContent === text,
  )
  if (!result) throw new Error('Button not found: ' + text)
  return result
}
async function click(text: string) {
  await act(async () => button(text).click())
}
async function change(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    const prototype =
      element.tagName === 'TEXTAREA' ?
        win.HTMLTextAreaElement.prototype
      : win.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
      element,
      value,
    )
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
function field(id: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('#config-' + id)!
}
function jsonEditor(): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>(
    '#config-panel-json textarea',
  )!
}
async function reveal() {
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('#config-panel-json input')!
      .click(),
  )
}

describe('Desktop config editor', () => {
  test('loads the active path and saves while offline, preserving hidden credentials and unknown fields', async () => {
    await render()
    expect(container.textContent).toContain('/custom-api-home/config.json')
    expect(container.textContent).toContain('The service is stopped')
    expect(container.textContent).not.toContain('contextManagement')
    expect(container.textContent).not.toContain(
      'modelResponsesApiCompactThresholds',
    )
    expect(button('Save configuration').disabled).toBe(true)
    await act(async () => field('useMessagesApi').click())
    await click('Save configuration')
    expect(save).toHaveBeenCalledTimes(1)
    const input = save.mock.calls[0][0]
    expect(input.revision).toBe('initial-revision')
    expect(JSON.parse(input.content)).toEqual({
      useMessagesApi: false,
      auth: { adminApiKey: 'test-admin-key', apiKeys: ['test-gateway-key'] },
      providers: { custom: { apiKey: 'test-provider-key' } },
      future: { keep: true },
    })
    expect(container.textContent).toContain('next service start')
    expect(button('Save configuration').disabled).toBe(true)
  })

  test('synchronizes form and JSON changes without saving masked placeholders', async () => {
    await render(true)
    await act(async () => field('useMessagesApi').click())
    await click('JSON')
    expect(jsonEditor().readOnly).toBe(true)
    expect(jsonEditor().value).toContain('••••••')
    expect(jsonEditor().value).not.toContain('test-admin-key')
    await reveal()
    const config = JSON.parse(jsonEditor().value) as Record<string, unknown>
    config.opencodeModelContextWindow = 320000
    config.useMessagesApi = true
    await change(jsonEditor(), JSON.stringify(config))
    await reveal()
    await click('Visual')
    expect(field('useMessagesApi').checked).toBe(true)
    expect(field('opencodeModelContextWindow').value).toBe('320000')
    await click('Save and apply')
    expect(save.mock.calls[0][0].content).toContain('test-admin-key')
    expect(save.mock.calls[0][0].content).not.toContain('••••••')
  })

  test('validates JSON syntax, root shape and field types, keeping invalid drafts editable', async () => {
    await render()
    await click('JSON')
    await reveal()
    await change(jsonEditor(), '{invalid')
    expect(button('Visual').disabled).toBe(true)
    expect(button('Save configuration').disabled).toBe(true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Invalid JSON',
    )
    await change(jsonEditor(), '[]')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'JSON object',
    )
    await change(jsonEditor(), '{"opencodeModelContextWindow":0}')
    expect(button('Save configuration').disabled).toBe(true)
    await click('Visual')
    await change(field('opencodeModelContextWindow'), '128000')
    expect(button('Save configuration').disabled).toBe(false)
    await click('Discard changes')
    expect(field('opencodeModelContextWindow').value).toBe('400000')
  })

  test('repairs a corrupt file only after revealing its raw contents', async () => {
    documentFixture.content = '{"anthropicApiKey":"test-broken-key",'
    await render()
    expect(jsonEditor().readOnly).toBe(true)
    expect(jsonEditor().value).not.toContain('test-broken-key')
    await reveal()
    expect(jsonEditor().value).toContain('test-broken-key')
    await change(jsonEditor(), '{"anthropicApiKey":"test-broken-key"}')
    await click('Save configuration')
    expect(save.mock.calls[0][0].content).toContain('test-broken-key')
  })

  test('preserves a conflict draft and explicitly reloads the new disk version', async () => {
    await render()
    save.mockRejectedValueOnce(
      new Error('Config changed on disk. Reload the file.'),
    )
    await act(async () => field('useMessagesApi').click())
    await click('Save configuration')
    expect(field('useMessagesApi').checked).toBe(false)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'changed on disk',
    )
    documentFixture = {
      ...documentFixture,
      revision: 'external-revision',
      content: '{"useMessagesApi":true}',
    }
    await click('Reload and discard changes')
    expect(field('useMessagesApi').checked).toBe(true)
    await act(async () => field('useMessagesApi').click())
    await click('Save configuration')
    expect(save.mock.calls[1][0].revision).toBe('external-revision')
  })

  test('separates saved state from refresh failure and retries without another write', async () => {
    await render(true)
    save.mockImplementationOnce((input) => {
      documentFixture = {
        ...documentFixture,
        ...input,
        revision: 'persisted-revision',
      }
      return Promise.resolve({
        ...documentFixture,
        saved: true,
        applied: false,
        refreshError: 'offline upstream',
      })
    })
    await act(async () => field('useMessagesApi').click())
    await click('Save and apply')
    expect(container.textContent).toContain(
      'Configuration saved, but applying it failed',
    )
    expect(button('Save and apply').disabled).toBe(true)
    await click('Retry apply')
    expect(apply).toHaveBeenCalledWith('persisted-revision')
    expect(save).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('saved and applied')
  })

  test('reports load and apply errors without discarding edits', async () => {
    read.mockRejectedValueOnce(new Error('permission denied'))
    await render(true)
    expect(container.textContent).toContain('permission denied')
    expect(button('Save and apply').disabled).toBe(true)
    await click('Reload')
    expect(field('useMessagesApi').checked).toBe(true)
    save.mockImplementationOnce((input) => {
      documentFixture = { ...documentFixture, ...input }
      return Promise.resolve({
        ...documentFixture,
        saved: true,
        applied: false,
        refreshError: 'refresh failed',
      })
    })
    await act(async () => field('useMessagesApi').click())
    await click('Save and apply')
    apply.mockRejectedValueOnce(new Error('Config changed on disk'))
    await click('Retry apply')
    expect(container.textContent).toContain('Config changed on disk')
    expect(field('useMessagesApi').checked).toBe(false)
  })

  test('uses one draft for model mapping rows and the full JSON document', async () => {
    await render()
    await click('Model mappings')
    await click('Add mapping')
    const inputs = () => [
      ...container.querySelectorAll<HTMLInputElement>(
        '#config-panel-form section input',
      ),
    ]
    await change(inputs()[4], 'alias.model')
    expect(button('JSON').disabled).toBe(true)
    expect(button('Save configuration').disabled).toBe(true)
    await change(inputs()[5], 'custom/model.1')
    await click('JSON')
    await reveal()
    expect(
      (
        JSON.parse(jsonEditor().value) as {
          modelMappings: Record<string, string>
        }
      ).modelMappings['alias.model'],
    ).toBe('custom/model.1')
    await click('Visual')
    await change(inputs()[4], 'codex-auto-review')
    expect(container.textContent).toContain('Duplicate requested model')
    // Clicking the already-selected Visual tab must preserve the invalid row.
    await click('Visual')
    expect(inputs()[4].value).toBe('codex-auto-review')
    await act(async () =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          '#config-panel-form section button',
        ),
      ]
        .filter((el) => el.textContent === 'Remove')[2]
        .click(),
    )
    expect(button('JSON').disabled).toBe(false)
    await click('Reset group to defaults')
    await click('JSON')
    await reveal()
    expect(
      (JSON.parse(jsonEditor().value) as Record<string, unknown>).modelMappings,
    ).toBeUndefined()
  })

  test('supports model rules, inherited values, explicit disable and group resets', async () => {
    await render()
    await click('Model rules')
    const modelMode = container.querySelector<HTMLSelectElement>(
      '#config-claudeAutoModel',
    )!
    const select = async (value: string) => {
      await act(async () => {
        modelMode.value = value
        modelMode.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    await select('off')
    await click('JSON')
    await reveal()
    expect(
      (JSON.parse(jsonEditor().value) as { claudeAutoModel: string })
        .claudeAutoModel,
    ).toBe('')
    await click('Visual')
    const mode = container.querySelector<HTMLSelectElement>(
      '#config-claudeAutoModel',
    )!
    await act(async () => {
      mode.value = 'custom'
      mode.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const modelInput = container.querySelector<HTMLInputElement>(
      '[aria-label="Specify a model"]',
    )!
    await change(modelInput, '')
    expect(
      container.querySelector('[aria-label="Specify a model"]'),
    ).not.toBeNull()
    expect(button('Save configuration').disabled).toBe(true)
    await change(modelInput, 'custom/review-model')
    const prompts = container.querySelector<HTMLTextAreaElement>(
      '#config-extraPrompts',
    )!
    await change(prompts, '{broken')
    expect(button('Save configuration').disabled).toBe(true)
    await change(prompts, '{"model.1":"Be concise"}')
    expect(button('Save configuration').disabled).toBe(false)
    await click('Reset group to defaults')
    expect(
      container.querySelector<HTMLSelectElement>('#config-claudeAutoModel')!
        .value,
    ).toBe('default')
    await click('Search and images')
    await change(field('alphaSearchModel'), '')
    await change(field('imageEditModel'), 'bad/model')
    expect(button('Save configuration').disabled).toBe(true)
    await change(field('imageEditModel'), 'xai/image-model')
    expect(button('Save configuration').disabled).toBe(false)
    await click('Upstream transport')
    await change(field('headersTimeoutMs'), '0')
    expect(button('Save configuration').disabled).toBe(true)
    await click('Reset group to defaults')
    expect(field('headersTimeoutMs').value).toBe('300000')
  })

  test('redacts change previews and discards changes without leaking values', async () => {
    await render()
    await click('JSON')
    await reveal()
    await change(
      jsonEditor(),
      '{"auth":{"adminApiKey":"new-test-secret"},"useMessagesApi":false}',
    )
    await click('Review changes')
    const review = container.querySelector(
      'section[aria-label="Review changes"]',
    )!
    expect(review.textContent).not.toContain('new-test-secret')
    expect(review.textContent).not.toContain('test-provider-key')
    expect(review.textContent).toContain('••••••')
    await click('Close')
    await click('Format')
    expect(jsonEditor().value).toContain('\n')
    await click('Discard changes')
    expect(jsonEditor().value).toBe(documentFixture.content)
  })

  test('can persist JSON-only formatting and remove an explicit field override', async () => {
    await render()
    await click('JSON')
    await reveal()
    await click('Format')
    expect(button('Save configuration').disabled).toBe(false)
    expect(container.textContent).toContain('Unsaved changes')
    await click('Save configuration')
    expect(save.mock.calls[0][0].content).toContain('\n')
    await click('Visual')
    await click('Use default')
    await click('Save configuration')
    expect(JSON.parse(save.mock.calls[1][0].content)).not.toHaveProperty(
      'useMessagesApi',
    )
  })

  test('ignores a document response after unmount', async () => {
    const pending = Promise.withResolvers<AppConfigDocument>()
    read.mockImplementationOnce(() => pending.promise)
    await render()
    await act(async () => root.render(null))
    await act(async () => pending.resolve(documentFixture))
    expect(container.textContent).toBe('')
  })
})
