import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, createElement } from 'react'
import ClientIntegrationsPage from '../src/pages/ClientIntegrationsPage'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import { createTestDom } from './helpers/dom'
import type {
  ClientIntegrationsState,
  ClientSetupInput,
} from '../shared/client-integrations'
import type { ClientIntegrationReply } from '../src/types/ipc'

let dom: Awaited<ReturnType<typeof createTestDom>>
let state: ClientIntegrationsState
let readState: ReturnType<
  typeof mock<() => Promise<ClientIntegrationReply<ClientIntegrationsState>>>
>
let setup: ReturnType<
  typeof mock<
    (
      input: ClientSetupInput,
    ) => ReturnType<Window['electronAPI']['setupClient']>
  >
>
let restore: ReturnType<typeof mock<Window['electronAPI']['restoreClient']>>
let getModels: ReturnType<typeof mock<Window['electronAPI']['getClientModels']>>
let install: ReturnType<
  typeof mock<Window['electronAPI']['installHarnessPlugin']>
>
let open: ReturnType<typeof mock<Window['electronAPI']['openClientConfig']>>

beforeEach(async () => {
  dom = await createTestDom()
  state = {
    baseUrl: 'http://localhost:5141',
    apiKeys: ['private-gateway-key'],
    harnessProfiles: ['desktop', 'web'],
    clients: (['claude', 'opencode', 'codex'] as const).map((client) => ({
      client,
      configPath: `/home/test/${client}/settings`,
      state: 'unconfigured',
      revision: `${client}-revision`,
      canRestore: false,
      model: '',
      smallModel: '',
      nativeToolSearch: false,
      agentContext: false,
      plugins: [],
    })),
  }
  readState = mock(() => Promise.resolve({ data: structuredClone(state) }))
  setup = mock((input) =>
    Promise.resolve({
      data: {
        status: {
          ...state.clients.find((item) => item.client === input.client)!,
          ...input,
          state: 'configured',
          canRestore: true,
          revision: 'saved',
        },
      },
    }),
  )
  restore = mock((client) =>
    Promise.resolve({
      data: {
        ...state.clients.find((item) => item.client === client)!,
        revision: 'restored',
      },
    }),
  )
  getModels = mock((client) =>
    Promise.resolve({
      data:
        client === 'claude' ?
          [
            { id: 'codex/my-claude-gpt[1m]', name: 'GPT (codex)' },
            { id: 'my-claude-small[1m]', name: 'Small (github-copilot)' },
          ]
        : [{ id: 'codex/gpt', name: 'GPT (codex)' }],
    }),
  )
  install = mock(() => Promise.resolve({ data: undefined }))
  open = mock(() => Promise.resolve({ data: undefined }))
  Object.defineProperty(dom.win, 'electronAPI', {
    configurable: true,
    value: {
      getClientIntegrations: readState,
      getClientModels: getModels,
      setupClient: setup,
      restoreClient: restore,
      installHarnessPlugin: install,
      openClientConfig: open,
    },
  })
})
afterEach(async () => {
  await act(async () => dom.root.unmount())
  await dom.cleanup()
})
async function render(serverRunning = true, initialBaseUrl?: string) {
  await act(async () =>
    dom.root.render(
      createElement(LanguageProvider, {
        children: createElement(ClientIntegrationsPage, {
          serverRunning,
          initialBaseUrl,
        }),
      }),
    ),
  )
}
function card(client: string) {
  return dom.container.querySelector<HTMLElement>(`[data-client="${client}"]`)!
}
function button(container: HTMLElement, text: string) {
  const found = [...container.querySelectorAll('button')].find(
    (item) => item.textContent === text,
  )
  if (!found) throw new Error('Button not found: ' + text)
  return found
}
async function click(container: HTMLElement, text: string) {
  await act(async () => button(container, text).click())
}
async function select(client: string, index: number, value: string) {
  await act(async () => {
    const element = card(client).querySelectorAll('select')[index]
    element.value = value
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function profile(value: string) {
  await act(async () => {
    const element = card('harness').querySelector('input')!
    Object.getOwnPropertyDescriptor(
      dom.win.HTMLInputElement.prototype,
      'value',
    )!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('client integration page', () => {
  test('shows all cards immediately while configuration loads and fills saved settings in later', async () => {
    let complete!: (
      reply: ClientIntegrationReply<ClientIntegrationsState>,
    ) => void
    readState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    await render(true, 'http://localhost:5141')
    expect(dom.container.querySelectorAll('[data-client]')).toHaveLength(4)
    expect(dom.container.textContent).toContain('http://localhost:5141')
    expect(dom.container.textContent).toContain('Checking…')
    expect(dom.container.textContent).not.toContain('Authentication disabled')
    expect(button(card('opencode'), 'Configure client').disabled).toBe(true)
    expect(
      card('opencode').querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )!.checked,
    ).toBe(true)
    expect(button(card('harness'), 'Install plugin').disabled).toBe(true)
    expect(getModels).toHaveBeenCalledTimes(2)

    state.clients[2].model = 'existing-model'
    state.harnessProfiles = ['desktop']
    await act(async () => complete({ data: structuredClone(state) }))
    expect(card('codex').querySelector('select')!.value).toBe('existing-model')
    expect(card('harness').querySelector('input')!.value).toBe('desktop')
    expect(button(card('opencode'), 'Configure client').disabled).toBe(false)
    expect(button(card('harness'), 'Install plugin').disabled).toBe(false)
    await profile('custom-profile')
    await click(dom.container, 'Refresh')
    expect(card('harness').querySelector('input')!.value).toBe('custom-profile')
  })
  test('shows four clients, only OpenCode v2, and masked gateway key choices', async () => {
    await render()
    expect(dom.container.querySelectorAll('[data-client]')).toHaveLength(4)
    expect(
      [...dom.container.querySelectorAll('[data-client] h3')].map(
        (heading) => heading.textContent,
      ),
    ).toEqual(['Codex', 'Claude Code', 'OpenCode v2', 'DeepSeek Harness'])
    expect(card('opencode').textContent).toContain('OpenCode v2 only')
    expect(dom.container.textContent).not.toContain('OpenCode v1')
    expect(dom.container.textContent).not.toContain('private-gateway-key')
    expect(dom.container.textContent).toContain('http://localhost:5141')
    expect(dom.container.textContent).toContain('Gateway key 1')
    expect(button(card('claude'), 'Configure client').disabled).toBe(true)
    expect(getModels.mock.calls.map((call) => call[0])).toEqual([
      'claude',
      'codex',
    ])
  })
  test('requires a Claude default model and saves separate main/fast models', async () => {
    await render()
    await select('claude', 0, 'codex/my-claude-gpt[1m]')
    await select('claude', 1, 'my-claude-small[1m]')
    await click(card('claude'), 'Configure client')
    expect(setup.mock.calls[0][0]).toMatchObject({
      client: 'claude',
      revision: 'claude-revision',
      model: 'codex/my-claude-gpt[1m]',
      smallModel: 'my-claude-small[1m]',
      apiKey: 'private-gateway-key',
    })
    expect(card('claude').textContent).toContain('Configuration saved')
    expect(card('claude').textContent).toContain('Configured')
    await click(card('claude'), 'Open configuration')
    expect(open).toHaveBeenCalledWith('claude')
    await click(card('claude'), 'Restore backup')
    expect(restore).toHaveBeenCalledWith('claude', 'saved')
    expect(card('claude').textContent).toContain(
      'Original configuration restored',
    )
  })
  test('keeps native Tool Search and its bridge exclusive and reports partial plugin failures', async () => {
    setup.mockImplementation((input) =>
      Promise.resolve({
        data: {
          status: {
            ...state.clients[0],
            ...input,
            state: 'configured',
            canRestore: true,
          },
          pluginError: 'commandMissing',
          pluginFailure: {
            command: 'claude plugin list --json',
            exitCode: '1',
          },
        },
      }),
    )
    await render()
    await select('claude', 0, 'codex/my-claude-gpt[1m]')
    const checkboxes = card('claude').querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    )
    await act(async () => checkboxes[2].click())
    await act(async () => checkboxes[0].click())
    expect(checkboxes[2].checked).toBe(false)
    await act(async () => checkboxes[2].click())
    expect(checkboxes[0].checked).toBe(false)
    await act(async () => checkboxes[1].click())
    await click(card('claude'), 'Configure client')
    expect(setup.mock.calls[0][0].plugins).toEqual([
      'tool-search',
      'agent-inject',
    ])
    expect(setup.mock.calls[0][0].nativeToolSearch).toBe(false)
    expect(card('claude').textContent).toContain(
      'Configuration saved, but plugin installation failed',
    )
    expect(card('claude').textContent).toContain('Client command not found')
    expect(card('claude').textContent).toContain('claude plugin list --json')
    expect(card('claude').textContent).toContain('Exit code: 1')
    setup.mockImplementationOnce((input) =>
      Promise.resolve({
        data: {
          status: { ...state.clients[0], ...input, state: 'configured' },
          pluginError: 'commandFailed',
          pluginFailure: { command: 'claude plugin list --json' },
        },
      }),
    )
    await click(card('claude'), 'Update configuration')
    expect(card('claude').textContent).not.toContain('Exit code:')
  })
  test('installs OpenCode plugins while stopped and does not fetch model catalogs', async () => {
    state.apiKeys = []
    await render(false)
    expect(getModels).not.toHaveBeenCalled()
    expect(dom.container.textContent).toContain('Authentication disabled')
    expect(dom.container.textContent).toContain('Start the gateway to load')
    expect(
      card('opencode').querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )!.checked,
    ).toBe(true)
    await click(card('opencode'), 'Configure client')
    expect(setup.mock.calls[0][0]).toMatchObject({
      client: 'opencode',
      agentContext: true,
      apiKey: 'dummy',
    })
  })
  test('keeps Agent Context disabled after saving that choice', async () => {
    await render(false)
    await act(async () =>
      card('opencode')
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click(),
    )
    await click(card('opencode'), 'Configure client')
    expect(setup.mock.calls[0][0].agentContext).toBe(false)
    expect(
      card('opencode').querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )!.checked,
    ).toBe(false)
  })
  test('preserves existing offline model choices and explains Codex environment activation', async () => {
    state.clients[2] = {
      ...state.clients[2],
      state: 'configured',
      model: 'existing-model',
      canRestore: true,
    }
    await render(false)
    expect(card('codex').querySelector('select')!.value).toBe('existing-model')
    await click(card('codex'), 'Update configuration')
    expect(card('codex').textContent).toContain('Fully quit and reopen Codex')
    restore.mockResolvedValueOnce({ error: 'conflict' })
    await click(card('codex'), 'Restore backup')
    expect(card('codex').textContent).toContain('Configuration changed on disk')
  })
  test('installs the Harness plugin for a selected profile, validates names and reports command errors', async () => {
    await render()
    expect(card('harness').querySelector('input')!.value).toBe('web')
    await profile('desktop')
    await click(card('harness'), 'Install plugin')
    expect(install).toHaveBeenCalledWith('desktop')
    expect(card('harness').textContent).toContain('Plugin installed')
    await profile('../../escape')
    expect(button(card('harness'), 'Install plugin').disabled).toBe(true)
    await profile('web')
    install.mockResolvedValueOnce({ error: 'commandFailed' })
    await click(card('harness'), 'Install plugin')
    expect(card('harness').textContent).toContain('The client command failed')
  })
  test('shows recoverable read/model/setup errors without exposing arbitrary error text', async () => {
    readState.mockResolvedValueOnce({ error: 'private-error-content' })
    await render()
    expect(dom.container.textContent).toContain('The operation failed')
    expect(dom.container.textContent).not.toContain('private-error-content')
    expect(dom.container.querySelectorAll('[data-client]')).toHaveLength(4)
    expect(button(card('opencode'), 'Configure client').disabled).toBe(true)
    getModels.mockResolvedValue({ error: 'modelsFailed' })
    await click(dom.container, 'Refresh')
    expect(dom.container.textContent).toContain('Could not load the models')
    setup.mockResolvedValueOnce({ error: 'invalidKey' })
    await click(card('opencode'), 'Configure client')
    expect(card('opencode').textContent).toContain('The gateway key changed')
  })
  test('disables setup for invalid existing configuration and offers opening it', async () => {
    state.clients[1].state = 'error'
    state.clients[1].error = 'invalidConfig'
    await render()
    expect(button(card('opencode'), 'Configure client').disabled).toBe(true)
    expect(card('opencode').textContent).toContain(
      'The existing configuration is invalid',
    )
    await click(card('opencode'), 'Open configuration')
    expect(open).toHaveBeenCalledWith('opencode')
  })
})
