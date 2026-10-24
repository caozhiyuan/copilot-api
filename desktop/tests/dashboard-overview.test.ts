import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

import App from '../src/App'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import DashboardPage from '../src/pages/DashboardPage'
import type {
  AppUpdateStatus,
  DesktopAuthMode,
  ProviderManagementConfig,
  ServerStatus,
  TokenUsageEventRecord,
  TokenUsageEventsPage,
  TokenUsagePeriod,
  TokenUsageSessionsPage,
  TokenUsageSummary,
} from '../src/types/ipc'

const summary: TokenUsageSummary = {
  period: 'today',
  range: { start_ms: 0, end_ms: 1, start_utc: '', end_utc: '' },
  totals: {
    request_count: 10,
    input_tokens: 200,
    output_tokens: 9000,
    cache_read_input_tokens: 600,
    cache_creation_input_tokens: 200,
    costs: [{ currency: 'USD', amount: 1.25, total_cost_nanos: 1_250_000_000 }],
    total_tokens: 10000,
  },
  byModel: [],
}

const providerConfig: ProviderManagementConfig = {
  configPath: 'config.json',
  providers: [
    {
      name: 'dashscope',
      type: 'openai-compatible',
      enabled: true,
      agentsModels: ['qwen-plus', 'qwen-coder'],
    },
    { name: 'codex', type: 'openai-responses', enabled: false },
    { name: 'github-copilot', type: 'github-copilot', enabled: true },
  ],
}

const copilotUsage = {
  copilot_plan: 'individual',
  quota_reset_date: '2026-11-01',
  quota_snapshots: {
    premium_interactions: {
      entitlement: 1500,
      remaining: 1049,
      percent_remaining: 69.9,
    },
    chat: { entitlement: 1500, remaining: 1500, percent_remaining: 100 },
    completions: { unlimited: true },
  },
}

let win: Window
let root: Root
let container: HTMLDivElement
let getProviderConfig: ReturnType<
  typeof mock<() => Promise<ProviderManagementConfig>>
>
let fetchCopilotUsage: ReturnType<typeof mock<() => Promise<unknown>>>
let fetchUsageSummary: ReturnType<
  typeof mock<(period: TokenUsagePeriod) => Promise<unknown>>
>
let openAuthConfig: ReturnType<
  typeof mock<(returnTab: 'dashboard' | 'providers') => void>
>
let currentAuthMode: DesktopAuthMode = 'provider'
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
  getProviderConfig = mock(() =>
    Promise.resolve(structuredClone(providerConfig)),
  )
  fetchCopilotUsage = mock(() => Promise.resolve(copilotUsage))
  fetchUsageSummary = mock((_period: TokenUsagePeriod) =>
    Promise.resolve(structuredClone(summary)),
  )
  currentAuthMode = 'provider'
  openAuthConfig = mock((_returnTab: 'dashboard' | 'providers') => {})
  Object.defineProperty(win, 'electronAPI', {
    configurable: true,
    value: {
      getAuthStatus: () =>
        Promise.resolve({ success: true, mode: currentAuthMode }),
      getSettings: () =>
        Promise.resolve({
          autoStartServer: false,
          lastPort: 4141,
          host: '127.0.0.1',
          language: 'en',
        }),
      getServerStatus: (): Promise<ServerStatus> =>
        Promise.resolve({ running: true, port: 4141, host: '127.0.0.1' }),
      getServerAuthInfo: () => Promise.resolve({ enabled: false }),
      getProviderManagementConfig: getProviderConfig,
      getProviderModelOptions: () => Promise.resolve({}),
      fetchUsage: fetchCopilotUsage,
      fetchModels: () => Promise.resolve({ data: [{ id: 'qwen-plus' }] }),
      fetchTokenUsage: fetchUsageSummary,
      fetchTokenUsageDaily: () =>
        Promise.resolve({ ...structuredClone(summary), days: [] }),
      fetchTokenUsageEvents: () => Promise.resolve(createEventsPage(6)),
      fetchTokenUsageSessions: () => Promise.resolve(emptySessionsPage()),
      getLogs: () => Promise.resolve([]),
      onServerStatus: () => () => {},
      onServerLog: () => () => {},
      getAppUpdateStatus: (): Promise<AppUpdateStatus> =>
        Promise.resolve({
          phase: 'disabled',
          currentVersion: '2.7.18',
          manualInstall: false,
          releaseUrl: '',
        }),
      onAppUpdateStatus: () => () => {},
      windowIsMaximized: () => Promise.resolve(false),
      onWindowMaximizeChange: () => () => {},
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  await win.happyDOM.close()
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  previousGlobals.clear()
})

function createEventsPage(count: number): TokenUsageEventsPage {
  const items: TokenUsageEventRecord[] = Array.from(
    { length: count },
    (_, index) => ({
      request_id: null,
      first_token_ms: null,
      duration_ms: null,
      request_outcome: null,
      output_tokens_per_second: null,
      id: count - index,
      created_at_ms: Date.UTC(2026, 9, 16, 3, 4, index),
      created_at_utc: '2026-10-16T03:04:00Z',
      trace_id: `trace-${index}`,
      user_agent: '',
      session_id: 'session-1',
      user_id: 'user',
      source: 'provider',
      endpoint: '/v1/messages',
      provider_name: 'dashscope',
      model: `model-${index}`,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cost: null,
      total_tokens: 30 + index,
    }),
  )
  return {
    items,
    page: 1,
    page_size: 10,
    period: 'today',
    range: summary.range,
    total: count,
    total_pages: 1,
  }
}

function emptySessionsPage(): TokenUsageSessionsPage {
  return {
    items: [],
    page: 1,
    page_size: 5,
    period: 'today',
    range: summary.range,
    total: 0,
    total_pages: 1,
  }
}

async function render(authMode: DesktopAuthMode = 'provider') {
  currentAuthMode = authMode
  await act(async () => {
    root.render(
      createElement(LanguageProvider, {
        children: createElement(DashboardPage, {
          authMode,
          defaultPort: 4141,
          defaultHost: '127.0.0.1',
          onChangeAuth: openAuthConfig,
        }),
      }),
    )
  })
  await act(async () => {})
}

function cardByTitle(title: string): HTMLElement {
  const heading = [...container.querySelectorAll('h3')].find(
    (node) => node.textContent === title,
  )
  const card = heading?.parentElement?.parentElement
  if (!card) throw new Error(`Missing card: ${title}`)
  return card
}

function metricText(label: string): string | null | undefined {
  const node = [...container.querySelectorAll('div')].find(
    (item) => item.childElementCount === 0 && item.textContent === label,
  )
  return node?.parentElement?.textContent
}

function metricLabels(): string[] {
  const grid = cardByTitle('Token usage').querySelector('.grid')
  if (!grid) throw new Error('Missing token usage metrics')
  return [...grid.children].map(
    (node) => node.lastElementChild?.textContent ?? '',
  )
}

async function clickButton(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === label,
  )
  if (!button) throw new Error(`Missing button: ${label}`)
  await act(async () => button.click())
}

describe('dashboard overview', () => {
  test('places providers at the top of the dashboard and keeps models in the sidebar', async () => {
    await render('provider')
    expect(
      [...container.querySelectorAll('[role="tab"]')].map(
        (tab) => tab.textContent,
      ),
    ).not.toContain('Create')

    const providerCard = cardByTitle('Providers')
    expect(providerCard.textContent).toContain('2 / 3 enabled')
    expect(
      [...providerCard.querySelectorAll('span')]
        .map((node) => node.textContent)
        .filter(
          (text) =>
            text === 'dashscope'
            || text === 'codex'
            || text === 'github-copilot',
        ),
    ).toEqual(['dashscope', 'github-copilot', 'codex'])
    expect(providerCard.textContent).toContain('Chat Completions')
    expect(providerCard.textContent).toContain('2 models')
    expect(providerCard.textContent).toContain('Disabled')

    const modelsCard = cardByTitle('Available models')
    expect(providerCard.parentElement?.firstElementChild).toBe(providerCard)
    expect(modelsCard.parentElement?.firstElementChild).toBe(modelsCard)
    expect(providerCard.parentElement).not.toBe(modelsCard.parentElement)
    expect(
      [...container.querySelectorAll('h3')].map((node) => node.textContent),
    ).not.toContain('Token usage')
    expect(container.textContent).not.toContain('Recent requests')

    expect(container.textContent).not.toContain('GitHub Copilot Quota')
    expect(container.textContent).not.toContain('Premium used')
    expect(container.textContent).not.toContain('Quota reset')
  })

  test('folds the Copilot plan into the quota card and hides the duplicate summary', async () => {
    await render('copilot')

    const quotaCard = cardByTitle('GitHub Copilot Quota')
    expect(quotaCard.textContent).toContain('individual')
    expect(quotaCard.textContent).toContain('resets 2026-11-01')
    expect(quotaCard.textContent).toContain('451 / 1500')
    expect(
      [...quotaCard.querySelectorAll('span')].map((node) => node.textContent),
    ).not.toContain('Chat')
    expect(quotaCard.textContent).not.toContain('Completions')

    expect(container.textContent).not.toContain('Premium used')
    expect(container.textContent).not.toContain('Quota reset')
    expect(container.textContent).not.toContain('Copilot Plan')

    // Several providers are enabled, so the overview stays visible in Copilot mode.
    expect(cardByTitle('Providers').textContent).toContain('2 / 3 enabled')
  })

  test('hides the provider overview when Copilot is the only enabled provider', async () => {
    getProviderConfig.mockImplementation(() =>
      Promise.resolve({
        configPath: 'config.json',
        providers: [
          { name: 'github-copilot', type: 'github-copilot', enabled: true },
        ],
      }),
    )
    await render('copilot')

    expect(cardByTitle('GitHub Copilot Quota').textContent).toContain(
      'individual',
    )
    expect(container.querySelector('h3') === null).toBe(false)
    expect(
      [...container.querySelectorAll('h3')].map((node) => node.textContent),
    ).not.toContain('Providers')
  })

  test('keeps plan and reset information visible when Copilot reports no quota details', async () => {
    fetchCopilotUsage.mockResolvedValue({
      copilot_plan: copilotUsage.copilot_plan,
      quota_reset_date: copilotUsage.quota_reset_date,
    })
    await render('copilot')

    const quotaCard = cardByTitle('GitHub Copilot Quota')
    expect(quotaCard.textContent).toContain('individual')
    expect(quotaCard.textContent).toContain('resets 2026-11-01')
    expect(quotaCard.textContent).toContain('No quota details reported.')
    expect(quotaCard.textContent).not.toContain('Premium')
    expect(cardByTitle('Available models').textContent).toContain('qwen-plus')
  })

  test('refreshes provider status from the dashboard', async () => {
    await render('provider')
    getProviderConfig.mockResolvedValue({
      ...providerConfig,
      providers: providerConfig.providers.map((provider) => ({
        ...provider,
        enabled: provider.name === 'codex',
      })),
    })

    await clickButton('Refresh')

    const providerCard = cardByTitle('Providers')
    expect(providerCard.textContent).toContain('1 / 3 enabled')
    expect(providerCard.querySelector('div.bg-sunken')?.textContent).toContain(
      'codex',
    )
  })

  test('keeps the previous provider overview when refreshing its config fails', async () => {
    await render('provider')
    getProviderConfig.mockRejectedValueOnce(new Error('Config unavailable'))

    await clickButton('Refresh')

    const providerCard = cardByTitle('Providers')
    expect(providerCard.textContent).toContain('2 / 3 enabled')
    expect(providerCard.textContent).toContain('dashscope')
    expect(providerCard.textContent).toContain('codex')
  })

  test('reloads the provider overview after returning from provider management', async () => {
    await render('provider')
    await clickButton('Manage')
    getProviderConfig.mockResolvedValue({
      ...providerConfig,
      providers: [{ name: 'new-provider', type: 'anthropic', enabled: true }],
    })

    await clickButton('Dashboard')

    const providerCard = cardByTitle('Providers')
    expect(providerCard.textContent).toContain('1 / 1 enabled')
    expect(providerCard.textContent).toContain('new-provider')
    expect(providerCard.textContent).not.toContain('dashscope')
  })

  test('hides cached Copilot quota after disabling its provider', async () => {
    await render('copilot')
    expect(cardByTitle('GitHub Copilot Quota').textContent).toContain(
      '451 / 1500',
    )
    await clickButton('Manage')
    getProviderConfig.mockResolvedValue({
      ...providerConfig,
      providers: providerConfig.providers.map((provider) => ({
        ...provider,
        enabled: provider.name === 'github-copilot' ? false : provider.enabled,
      })),
    })

    await clickButton('Dashboard')

    expect(
      [...container.querySelectorAll('h3')].map((node) => node.textContent),
    ).not.toContain('GitHub Copilot Quota')
    expect(cardByTitle('Providers').textContent).toContain('1 / 3 enabled')
    expect(cardByTitle('Providers').textContent).toContain('github-copilot')
    expect(container.textContent).not.toContain('451 / 1500')
  })

  test('opens auth configuration from the Providers page', async () => {
    await render('provider')
    await clickButton('Manage')
    expect(openAuthConfig).not.toHaveBeenCalled()

    await clickButton('Auth config')

    expect(openAuthConfig).toHaveBeenCalledTimes(1)
    expect(openAuthConfig).toHaveBeenCalledWith('providers')
  })

  for (const source of ['dashboard', 'providers'] as const) {
    test(`returns from auth configuration to ${source}`, async () => {
      await act(async () => {
        root.render(
          createElement(LanguageProvider, {
            children: createElement(App),
          }),
        )
      })
      await act(async () => {})

      if (source === 'providers') {
        await clickButton('Manage')
      } else {
        await clickButton('File')
      }
      await clickButton('Auth config')

      const backLabel = source === 'providers' ? '← Providers' : '← Home'
      expect(
        [...container.querySelectorAll('button')].some(
          (node) => node.textContent === backLabel,
        ),
      ).toBe(true)
      expect(container.querySelector('[role="tab"]')).toBeNull()

      await clickButton(backLabel)

      expect(
        container.querySelector('[role="tab"][aria-selected="true"]')
          ?.textContent,
      ).toBe(source === 'providers' ? 'Providers' : 'Dashboard')
      if (source === 'providers') {
        expect(container.querySelector('h2')?.textContent).toBe('Providers')
      } else {
        expect(cardByTitle('Available models').textContent).toContain(
          'qwen-plus',
        )
      }
    })
  }

  const costScenarios: Array<{
    name: string
    costs: TokenUsageSummary['totals']['costs']
    expected: Array<{ label: string; value: string }>
  }> = [
    {
      name: 'CNY only',
      costs: [
        { currency: 'CNY', amount: 9.5, total_cost_nanos: 9_500_000_000 },
      ],
      expected: [{ label: 'Cost (CNY)', value: '¥9.500000' }],
    },
    {
      name: 'USD and CNY',
      costs: [
        ...summary.totals.costs,
        { currency: 'CNY', amount: 9.5, total_cost_nanos: 9_500_000_000 },
      ],
      expected: [
        { label: 'Cost (USD)', value: '$1.250000' },
        { label: 'Cost (CNY)', value: '¥9.500000' },
      ],
    },
    {
      name: 'EUR only',
      costs: [
        { currency: 'EUR', amount: 2.5, total_cost_nanos: 2_500_000_000 },
      ],
      expected: [{ label: 'Cost (EUR)', value: 'EUR 2.500000' }],
    },
    {
      name: 'no recorded costs',
      costs: [],
      expected: [{ label: 'Cost', value: '—' }],
    },
  ]

  for (const { name, costs, expected } of costScenarios) {
    test(`renders detail metric ordering and currency labels for ${name}`, async () => {
      fetchUsageSummary.mockResolvedValue({
        ...summary,
        totals: { ...summary.totals, costs },
      })
      await render('provider')
      await clickButton('Token usage')

      const labels = metricLabels()
      expect(labels).toEqual([
        'Total',
        'Input',
        'Output',
        'Cache read',
        'Cache write',
        'Cache hit rate',
        'Requests',
        ...expected.map((cost) => cost.label),
      ])
      for (const { label, value } of expected) {
        expect(metricText(label)).toBe(`${value}${label}`)
      }
    })
  }
})

describe('usage timing display', () => {
  test('shows model timing before Total Tokens and only duration in request events', async () => {
    fetchUsageSummary.mockResolvedValue({
      ...summary,
      byModel: [
        {
          ...summary.totals,
          model: 'timed-model',
          average_first_token_ms: 1250,
          output_tokens_per_second: 42.6,
        },
      ],
    })
    const events = createEventsPage(2)
    Object.assign(events.items[0], {
      first_token_ms: 250,
      duration_ms: 2250,
      output_tokens_per_second: 10,
    })
    window.electronAPI.fetchTokenUsageEvents = mock(() =>
      Promise.resolve(events),
    )
    await render()
    await clickButton('Token usage')
    const tables = [...container.querySelectorAll('table')]
    const models = tables.find((table) =>
      table.textContent?.includes('timed-model'),
    )!
    const details = tables.find((table) =>
      table.textContent?.includes('trace-0'),
    )!
    expect(details.className).toContain('min-w-[1140px]')
    expect(
      [...models.querySelectorAll('th')].map((cell) => cell.textContent),
    ).toEqual([
      'Model',
      'Requests',
      'Input',
      'Output',
      'Cache read',
      'Cache write',
      'Cache hit rate',
      'Avg. TTFT',
      'Output speed',
      'Total Tokens',
      'Total Cost',
    ])
    expect(models.querySelector('th')?.className).toContain('w-[220px]')
    expect(models.textContent).toContain('1.25 s')
    expect(models.textContent).toContain('42.6 tok/s')
    expect(
      [...details.querySelectorAll('th')].map((cell) => cell.textContent),
    ).toEqual([
      'Time',
      'User',
      'Model',
      'Session',
      'Trace',
      'Input',
      'Output',
      'Cache read',
      'Cache write',
      'Duration',
      'Total Tokens',
      'Total Cost',
    ])
    const rows = details.querySelectorAll('tbody tr')
    expect(rows[0].textContent).not.toContain('250 ms')
    expect(rows[0].textContent).not.toContain('10.0 tok/s')
    expect(rows[0].textContent).toContain('2.25 s')
    expect(rows[0].querySelectorAll('td')).toHaveLength(12)
  })
})
