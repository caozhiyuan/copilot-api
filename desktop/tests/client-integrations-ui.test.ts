import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, createElement } from 'react'
import ClientIntegrationsPage from '../src/pages/ClientIntegrationsPage'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import { createTestDom } from './helpers/dom'
import {
  CODEX_CLIENT_DEFAULTS,
  type CodexClientSettings,
  type ClientAgent,
  type ClientModelOption,
  type ClientIntegrationsState,
  type ClientSetupInput,
  type ClientIntegrationStatus,
} from '../shared/client-integrations'
import type { ClientIntegrationReply } from '../src/types/ipc'

let dom: Awaited<ReturnType<typeof createTestDom>>
let state: ClientIntegrationsState
let readState: ReturnType<
  typeof mock<Window['electronAPI']['getClientIntegrations']>
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
let open: ReturnType<typeof mock<Window['electronAPI']['openClientConfig']>>

function savedStatus(input: ClientSetupInput): ClientIntegrationStatus {
  const previous = state.clients.find((item) => item.client === input.client)!
  return {
    ...previous,
    ...input,
    codex:
      input.client === 'codex' ?
        {
          ...CODEX_CLIENT_DEFAULTS,
          ...previous.codex,
          ...Object.fromEntries(
            Object.entries(input.codex ?? {}).filter(
              ([, value]) => value !== undefined,
            ),
          ),
        }
      : undefined,
    state: 'configured',
    canRestore: true,
    revision: 'saved',
  }
}

beforeEach(async () => {
  dom = await createTestDom()
  state = {
    baseUrl: 'http://localhost:5141',
    apiKeys: ['private-gateway-key'],
    harnessProfiles: ['desktop', 'web'],
    clients: (['claude', 'opencode', 'codex', 'harness'] as const).map(
      (client) => ({
        client,
        configPath: `/home/test/${client}/settings`,
        state: 'unconfigured',
        revision: `${client}-revision`,
        canRestore: false,
        model: '',
        fableModel: '',
        opusModel: '',
        sonnetModel: '',
        smallModel: '',
        reviewModel: '',
        nativeToolSearch: false,
        agentContext: false,
        plugins: [],
      }),
    ),
  }
  readState = mock((agent) => {
    const value = structuredClone(state)
    value.clients = value.clients.filter(
      (item) => !agent || item.client === agent,
    )
    if (agent && agent !== 'harness') value.harnessProfiles = []
    return Promise.resolve({ data: value })
  })
  setup = mock((input) =>
    Promise.resolve({
      data: {
        status: savedStatus(input),
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
        : [
            {
              id: 'codex/gpt',
              name: 'GPT (codex)',
              reasoningEfforts: ['low', 'high', 'max', 'ultra'],
            },
          ],
    }),
  )
  open = mock(() => Promise.resolve({ data: undefined }))
  Object.defineProperty(dom.win, 'electronAPI', {
    configurable: true,
    value: {
      getClientIntegrations: readState,
      getClientModels: getModels,
      setupClient: setup,
      restoreClient: restore,
      openClientConfig: open,
    },
  })
})
afterEach(async () => {
  await act(async () => dom.root.unmount())
  await dom.cleanup()
})
async function render(
  serverRunning = true,
  initialBaseUrl?: string,
  agent?: ClientAgent,
) {
  if (agent) dom.win.localStorage.setItem('copilot-api-client-agent', agent)
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
async function selectAgent(agent: ClientAgent) {
  await act(async () => {
    const element = dom.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Agent"]',
    )!
    element.value = agent
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
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
function codexField(label: string) {
  return card('codex').querySelector<HTMLSelectElement>(
    `select[aria-label="Codex: ${label}"]`,
  )!
}
async function selectCodex(label: string, value: string) {
  await act(async () => {
    const element = codexField(label)
    element.value = value
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
function featuresGroup() {
  return [...card('codex').querySelectorAll('fieldset')].find(
    (element) => element.querySelector('legend')?.textContent === 'Features',
  )!
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
  test('shows only the selected agent immediately and fills saved settings in later', async () => {
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
    expect(dom.container.querySelectorAll('[data-client]')).toHaveLength(1)
    expect(dom.container.textContent).toContain('http://localhost:5141')
    expect(dom.container.textContent).toContain('Checking…')
    expect(dom.container.textContent).not.toContain('Authentication disabled')
    expect(button(card('codex'), 'Configure client').disabled).toBe(true)
    expect(getModels.mock.calls.map((call) => call[0])).toEqual(['codex'])
    expect(readState).toHaveBeenCalledWith('codex')

    state.clients[2].model = 'existing-model'
    state.harnessProfiles = ['desktop']
    await act(async () => complete({ data: structuredClone(state) }))
    expect(card('codex').querySelector('select')!.value).toBe('existing-model')
    expect(button(card('codex'), 'Configure client').disabled).toBe(false)
    await selectAgent('harness')
    expect(card('harness').querySelector('input')!.value).toBe('desktop')
    expect(button(card('harness'), 'Configure client').disabled).toBe(false)
    await profile('custom-profile')
    await click(dom.container, 'Refresh')
    expect(card('harness').querySelector('input')!.value).toBe('custom-profile')
  })
  test('defaults to Codex, offers all four agents, and fetches only the selected catalogs', async () => {
    await render()
    expect(dom.container.querySelectorAll('[data-client]')).toHaveLength(1)
    const picker = dom.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Agent"]',
    )!
    expect(picker.value).toBe('codex')
    await selectAgent('codex')
    expect(button(dom.container, 'Refresh').disabled).toBe(false)
    expect([...picker.options].map((option) => option.textContent)).toEqual([
      'Codex',
      'OpenCode',
      'Claude Code',
      'DeepSeek Harness',
    ])
    expect(getModels).toHaveBeenCalledWith('codex')
    await selectAgent('opencode')
    expect(card('opencode').textContent).toContain('OpenCode v2 only')
    expect(dom.container.textContent).not.toContain('OpenCode v1')
    expect(dom.container.textContent).not.toContain('private-gateway-key')
    expect(dom.container.textContent).toContain('http://localhost:5141')
    expect(dom.container.textContent).toContain('Gateway key 1')
    expect(getModels).toHaveBeenCalledTimes(1)
    await selectAgent('claude')
    expect(button(card('claude'), 'Configure client').disabled).toBe(true)
    expect(getModels.mock.calls.map((call) => call[0])).toEqual([
      'codex',
      'claude',
    ])
    expect(readState.mock.calls.map((call) => call[0])).toEqual([
      'codex',
      'opencode',
      'claude',
    ])
  })
  test('groups Codex settings by function and offers official choices with the requested defaults', async () => {
    await render()
    expect(
      [...card('codex').querySelectorAll('legend')].map(
        (element) => element.textContent,
      ),
    ).toEqual(['Models', 'Sandbox and approvals', 'Search', 'Features'])
    for (const [label, options, selected] of [
      [
        'Sandbox mode',
        ['danger-full-access', 'workspace-write', 'read-only'],
        'danger-full-access',
      ],
      ['Approval reviewer', ['auto_review', 'user'], 'auto_review'],
      ['Web search', ['live', 'indexed', 'cached', 'disabled'], 'live'],
    ] as const) {
      expect([...codexField(label).options].map((item) => item.value)).toEqual([
        ...options,
      ])
      expect(codexField(label).value).toBe(selected)
    }
    const features = featuresGroup().querySelectorAll<HTMLInputElement>('input')
    expect([...features].map((element) => element.checked)).toEqual([
      false,
      true,
      true,
    ])
    await selectCodex('Default model', 'codex/gpt')
    expect(codexField('Reasoning effort').value).toBe('max')
    await click(card('codex'), 'Configure client')
    expect(setup.mock.calls[0][0].codex).toEqual(CODEX_CLIENT_DEFAULTS)
  })
  test('loads existing Codex choices, saves changed switches, and refreshes or restores their values', async () => {
    const original: CodexClientSettings = {
      ...CODEX_CLIENT_DEFAULTS,
      sandboxMode: 'read-only',
      approvalsReviewer: 'user',
      webSearch: 'cached',
      reasoningEffort: 'low',
      daemonAutoStart: true,
      defaultModeRequestUserInput: false,
      preventIdleSleep: false,
    }
    Object.assign(state.clients[2], {
      model: 'codex/gpt',
      state: 'configured',
      canRestore: true,
      codex: original,
    })
    await render()
    expect(codexField('Sandbox mode').value).toBe('read-only')
    expect(codexField('Approval reviewer').value).toBe('user')
    expect(codexField('Web search').value).toBe('cached')
    expect(codexField('Reasoning effort').value).toBe('low')
    expect(
      [...featuresGroup().querySelectorAll<HTMLInputElement>('input')].map(
        (element) => element.checked,
      ),
    ).toEqual([true, false, false])
    await selectCodex('Sandbox mode', 'workspace-write')
    await selectCodex('Approval reviewer', 'auto_review')
    await selectCodex('Web search', 'indexed')
    await selectCodex('Reasoning effort', 'high')
    await act(async () => {
      for (const input of featuresGroup().querySelectorAll<HTMLInputElement>(
        'input',
      ))
        input.click()
    })
    await click(card('codex'), 'Update configuration')
    expect(setup.mock.calls[0][0].codex).toEqual({
      ...CODEX_CLIENT_DEFAULTS,
      sandboxMode: 'workspace-write',
      webSearch: 'indexed',
      reasoningEffort: 'high',
    })
    await click(dom.container, 'Refresh')
    expect(codexField('Sandbox mode').value).toBe('read-only')
    expect(codexField('Reasoning effort').value).toBe('low')
    expect(
      [...featuresGroup().querySelectorAll<HTMLInputElement>('input')].map(
        (element) => element.checked,
      ),
    ).toEqual([true, false, false])
    restore.mockResolvedValueOnce({
      data: {
        ...state.clients[2],
        codex: CODEX_CLIENT_DEFAULTS,
        canRestore: false,
      },
    })
    await click(card('codex'), 'Restore backup')
    expect(codexField('Sandbox mode').value).toBe('danger-full-access')
    expect(codexField('Web search').value).toBe('live')
    expect(codexField('Reasoning effort').value).toBe('max')
    expect(
      [...featuresGroup().querySelectorAll<HTMLInputElement>('input')].map(
        (element) => element.checked,
      ),
    ).toEqual([false, true, true])
  })
  test('links reasoning levels to model changes and keeps manual effort choices while the model stays selected', async () => {
    getModels.mockResolvedValueOnce({
      data: [
        {
          id: 'wide',
          name: 'Wide',
          reasoningEfforts: ['ultra', 'medium', 'max', 'xhigh'],
        },
        {
          id: 'limited',
          name: 'Limited',
          reasoningEfforts: ['high', 'low', 'ultra'],
        },
        {
          id: 'no-reasoning',
          name: 'No reasoning',
          reasoningEfforts: ['none'],
        },
        {
          id: 'future',
          name: 'Future',
          reasoningEfforts: ['future-low', 'future-high'],
        },
        { id: 'unknown', name: 'Unknown' },
      ],
    })
    await render()
    await selectCodex('Default model', 'wide')
    expect(codexField('Reasoning effort').value).toBe('max')
    expect(
      [...codexField('Reasoning effort').options].map((option) => option.value),
    ).toEqual(['ultra', 'medium', 'max', 'xhigh'])
    await selectCodex('Reasoning effort', 'medium')
    await selectCodex('Web search', 'disabled')
    expect(codexField('Reasoning effort').value).toBe('medium')
    await selectCodex('Default model', 'limited')
    expect(codexField('Reasoning effort').value).toBe('high')
    expect(
      [...codexField('Reasoning effort').options].map((option) => option.value),
    ).toEqual(['high', 'low', 'ultra'])
    await selectCodex('Reasoning effort', 'low')
    await act(async () =>
      featuresGroup().querySelector<HTMLInputElement>('input')!.click(),
    )
    expect(codexField('Reasoning effort').value).toBe('low')
    await selectCodex('Default model', 'no-reasoning')
    expect(codexField('Reasoning effort').value).toBe('none')
    await selectCodex('Default model', 'future')
    expect(codexField('Reasoning effort').value).toBe('future-high')
    await selectCodex('Default model', 'unknown')
    expect(codexField('Reasoning effort').value).toBe('max')
    await selectCodex('Default model', 'limited')
    await click(card('codex'), 'Configure client')
    expect(setup.mock.calls[0][0].codex?.reasoningEffort).toBe('high')
  })
  test('updates the default effort when a delayed model catalog supplies lower supported levels', async () => {
    let complete!: (reply: ClientIntegrationReply<ClientModelOption[]>) => void
    getModels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    state.clients[2].model = 'limited'
    await render()
    expect(codexField('Reasoning effort').value).toBe('max')
    await act(async () =>
      complete({
        data: [
          { id: 'limited', name: 'Limited', reasoningEfforts: ['low', 'high'] },
        ],
      }),
    )
    expect(codexField('Reasoning effort').value).toBe('high')
  })
  test('shows existing future or legacy Codex options and leaves them untouched when updating another field', async () => {
    state.clients[2].model = 'codex/gpt'
    state.clients[2].codex = {
      ...CODEX_CLIENT_DEFAULTS,
      sandboxMode: 'future-sandbox',
      approvalsReviewer: 'guardian_subagent',
      webSearch: 'future-search',
    }
    await render(false)
    expect(codexField('Sandbox mode').value).toBe('future-sandbox')
    expect(codexField('Approval reviewer').value).toBe('guardian_subagent')
    expect(codexField('Web search').value).toBe('future-search')
    await selectCodex('Web search', 'live')
    await click(card('codex'), 'Configure client')
    expect(setup.mock.calls[0][0].codex).toMatchObject({
      sandboxMode: undefined,
      approvalsReviewer: undefined,
      webSearch: 'live',
    })
  })
  test('switches away from slow Codex checks and ignores late configuration and catalog replies', async () => {
    let completeState!: (
      reply: ClientIntegrationReply<ClientIntegrationsState>,
    ) => void
    let completeModels!: (
      reply: ClientIntegrationReply<ClientModelOption[]>,
    ) => void
    readState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeState = resolve
        }),
    )
    getModels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeModels = resolve
        }),
    )
    await render()
    await selectAgent('claude')
    await select('claude', 0, 'codex/my-claude-gpt[1m]')
    expect(button(card('claude'), 'Configure client').disabled).toBe(false)
    await act(async () => {
      completeState({ data: { ...state, clients: [state.clients[2]] } })
      completeModels({ data: [{ id: 'late-codex-model', name: 'Late' }] })
    })
    expect(dom.container.querySelectorAll('[data-client]')).toHaveLength(1)
    expect(card('claude').querySelector('select')!.value).toBe(
      'codex/my-claude-gpt[1m]',
    )
    expect(card('claude').textContent).not.toContain('late-codex-model')
    expect(button(card('claude'), 'Configure client').disabled).toBe(false)
  })
  test('ignores an invalid saved agent and remembers the selection when reopening the page', async () => {
    dom.win.localStorage.setItem('copilot-api-client-agent', 'invalid-agent')
    await render()
    expect(card('codex')).not.toBeNull()
    await selectAgent('opencode')
    expect(dom.win.localStorage.getItem('copilot-api-client-agent')).toBe(
      'opencode',
    )
    await act(async () => dom.root.render(null))
    await render()
    expect(dom.container.querySelectorAll('[data-client]')).toHaveLength(1)
    expect(card('opencode')).not.toBeNull()
    expect(readState.mock.calls.at(-1)?.[0]).toBe('opencode')
    expect(getModels).toHaveBeenCalledTimes(1)
  })
  test('requires a default model and saves four Claude aliases and the review model independently', async () => {
    await render(true, undefined, 'claude')
    expect(card('claude').querySelectorAll('select')[5].value).toBe('')
    await select('claude', 0, 'codex/my-claude-gpt[1m]')
    await select('claude', 1, 'my-claude-small[1m]')
    await select('claude', 2, 'codex/my-claude-gpt[1m]')
    await select('claude', 3, 'my-claude-small[1m]')
    await select('claude', 4, 'my-claude-small[1m]')
    await select('claude', 5, 'codex-auto-review')
    await click(card('claude'), 'Configure client')
    expect(setup.mock.calls[0][0]).toMatchObject({
      client: 'claude',
      revision: 'claude-revision',
      model: 'codex/my-claude-gpt[1m]',
      fableModel: 'my-claude-small[1m]',
      opusModel: 'codex/my-claude-gpt[1m]',
      sonnetModel: 'my-claude-small[1m]',
      smallModel: 'my-claude-small[1m]',
      reviewModel: 'codex-auto-review',
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
  test('loads each existing Claude model choice and leaves Review unselected when cleared', async () => {
    Object.assign(state.clients[0], {
      state: 'configured',
      model: 'existing-default',
      fableModel: 'existing-fable',
      opusModel: 'existing-default',
      sonnetModel: 'existing-sonnet',
      smallModel: 'existing-haiku',
      reviewModel: 'existing-review',
    })
    await render(false, undefined, 'claude')
    expect(
      [...card('claude').querySelectorAll('select')].map((el) => el.value),
    ).toEqual([
      'existing-default',
      'existing-fable',
      'existing-default',
      'existing-sonnet',
      'existing-haiku',
      'existing-review',
    ])
    await select('claude', 5, '')
    await click(card('claude'), 'Update configuration')
    expect(setup.mock.calls[0][0].reviewModel).toBe('')
    expect(card('claude').querySelectorAll('select')[5].value).toBe('')
    expect(setup.mock.calls[0][0].opusModel).toBe('existing-default')
  })
  test('reports successful restoration and any plugin uninstall failure together', async () => {
    Object.assign(state.clients[0], {
      state: 'configured',
      model: 'existing-model',
      canRestore: true,
    })
    restore.mockResolvedValueOnce({
      data: {
        ...state.clients[0],
        state: 'unconfigured',
        canRestore: false,
        pluginError: 'commandFailed',
        pluginFailure: {
          command:
            'claude plugin uninstall agent-inject@copilot-api-marketplace --scope user --keep-data',
          exitCode: '1',
        },
      },
    })
    await render(false, undefined, 'claude')
    await click(card('claude'), 'Restore backup')
    expect(card('claude').textContent).toContain(
      'Original configuration restored',
    )
    expect(card('claude').textContent).toContain(
      'Configuration restored, but plugin removal failed',
    )
    expect(card('claude').textContent).toContain('The client command failed')
    expect(card('claude').textContent).toContain('claude plugin uninstall')
    expect(card('claude').textContent).toContain('Exit code: 1')
    expect(card('claude').textContent).not.toContain(
      'plugin installation failed',
    )
    expect(
      [...card('claude').querySelectorAll('button')].some(
        (item) => item.textContent === 'Restore backup',
      ),
    ).toBe(false)
  })
  test('toggles native Tool Search and its bridge independently and reports partial plugin failures', async () => {
    setup.mockImplementation((input) =>
      Promise.resolve({
        data: {
          status: savedStatus(input),
          pluginError: 'commandMissing',
          pluginFailure: {
            command: 'claude plugin list --json',
            exitCode: '1',
          },
        },
      }),
    )
    await render(true, undefined, 'claude')
    await select('claude', 0, 'codex/my-claude-gpt[1m]')
    const checkboxes = card('claude').querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    )
    await act(async () => checkboxes[2].click())
    await act(async () => checkboxes[0].click())
    expect(checkboxes[2].checked).toBe(true)
    await act(async () => checkboxes[2].click())
    expect(checkboxes[0].checked).toBe(true)
    await act(async () => checkboxes[2].click())
    await act(async () => checkboxes[0].click())
    expect(checkboxes[2].checked).toBe(true)
    await act(async () => checkboxes[0].click())
    await act(async () => checkboxes[1].click())
    await click(card('claude'), 'Configure client')
    expect(setup.mock.calls[0][0].plugins).toEqual([
      'tool-search',
      'agent-inject',
    ])
    expect(setup.mock.calls[0][0].nativeToolSearch).toBe(true)
    expect(checkboxes[0].checked).toBe(true)
    expect(checkboxes[2].checked).toBe(true)
    expect(card('claude').textContent).toContain(
      'Configuration saved, but plugin installation failed',
    )
    expect(card('claude').textContent).toContain('Client command not found')
    expect(card('claude').textContent).toContain('claude plugin list --json')
    expect(card('claude').textContent).toContain('Exit code: 1')
    setup.mockImplementationOnce((input) =>
      Promise.resolve({
        data: {
          status: savedStatus(input),
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
    await render(false, undefined, 'opencode')
    expect(getModels).not.toHaveBeenCalled()
    expect(dom.container.textContent).toContain('Authentication disabled')
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
    await render(false, undefined, 'opencode')
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
  test('configures Harness with the selected key and profile and reports plugin errors', async () => {
    await render(true, undefined, 'harness')
    expect(getModels).not.toHaveBeenCalled()
    expect(dom.container.textContent).toContain('http://localhost:5141')
    expect(dom.container.textContent).toContain('Gateway key 1')
    expect(dom.container.textContent).not.toContain('private-gateway-key')
    expect(card('harness').querySelector('input')!.value).toBe('web')
    await profile('desktop')
    await click(card('harness'), 'Configure client')
    expect(setup.mock.calls[0][0]).toMatchObject({
      client: 'harness',
      profile: 'desktop',
      apiKey: 'private-gateway-key',
    })
    expect(card('harness').textContent).toContain('Configuration saved')
    await profile('../../escape')
    expect(button(card('harness'), 'Update configuration').disabled).toBe(true)
    await profile('web')
    setup.mockResolvedValueOnce({
      data: {
        status: { ...state.clients[3], state: 'configured', canRestore: true },
        pluginError: 'commandFailed',
      },
    })
    await click(card('harness'), 'Update configuration')
    expect(card('harness').textContent).toContain('The client command failed')
    await click(card('harness'), 'Restore backup')
    expect(restore).toHaveBeenCalledWith('harness', 'harness-revision')
  })
  test('shows recoverable read/model/setup errors without exposing arbitrary error text', async () => {
    readState.mockResolvedValueOnce({ error: 'private-error-content' })
    await render()
    expect(dom.container.textContent).toContain('The operation failed')
    expect(dom.container.textContent).not.toContain('private-error-content')
    expect(dom.container.querySelectorAll('[data-client]')).toHaveLength(1)
    expect(button(card('codex'), 'Configure client').disabled).toBe(true)
    getModels.mockResolvedValue({ error: 'modelsFailed' })
    state.clients[2].model = 'codex/gpt'
    await click(dom.container, 'Refresh')
    expect(dom.container.textContent).toContain('Could not load the models')
    setup.mockResolvedValueOnce({ error: 'invalidKey' })
    await click(card('codex'), 'Configure client')
    expect(card('codex').textContent).toContain('The gateway key changed')
  })
  test('disables setup for invalid existing configuration and offers opening it', async () => {
    state.clients[1].state = 'error'
    state.clients[1].error = 'invalidConfig'
    await render(true, undefined, 'opencode')
    expect(button(card('opencode'), 'Configure client').disabled).toBe(true)
    expect(card('opencode').textContent).toContain(
      'The existing configuration is invalid',
    )
    await click(card('opencode'), 'Open configuration')
    expect(open).toHaveBeenCalledWith('opencode')
  })
})
