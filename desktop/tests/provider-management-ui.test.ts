import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import ProviderManagementModal from '../src/components/ProviderManagementModal'
import ProviderManagementPanel from '../src/components/ProviderManagementPanel'
import DashboardPage from '../src/pages/DashboardPage'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import type {
  AppUpdateStatus,
  ProviderManagementConfig,
  ProviderManagementUpdate,
  ProviderModelOptions,
  ServerStatus,
  TokenUsagePeriod,
  TokenUsageSessionsPage,
  TokenUsageSummary,
} from '../src/types/ipc'

const fixture: ProviderManagementConfig = {
  configPath: 'config.json',
  providers: [
    { name: 'dashscope', type: 'openai-compatible', enabled: true },
    {
      name: 'codex',
      type: 'openai-responses',
      enabled: false,
      agentsModels: [],
    },
  ],
}
let win: Window
let root: Root
let container: HTMLDivElement
let getConfig: ReturnType<typeof mock<() => Promise<ProviderManagementConfig>>>
let saveConfig: ReturnType<
  typeof mock<
    (input: ProviderManagementUpdate) => Promise<ProviderManagementConfig>
  >
>
let getModelOptions: ReturnType<
  typeof mock<() => Promise<ProviderModelOptions>>
>
let fetchModels: ReturnType<typeof mock<() => Promise<unknown>>>
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
  getConfig = mock(() => Promise.resolve(structuredClone(fixture)))
  saveConfig = mock(() => Promise.resolve(structuredClone(fixture)))
  getModelOptions = mock(() =>
    Promise.resolve({
      dashscope: ['qwen-plus', 'qwen-coder'],
      codex: ['gpt-5.5', 'gpt-6.1-sol'],
    }),
  )
  fetchModels = mock(() =>
    Promise.resolve({ data: [{ id: 'codex/live-model' }] }),
  )
  Object.defineProperty(win, 'electronAPI', {
    configurable: true,
    value: {
      getProviderManagementConfig: getConfig,
      saveProviderManagementConfig: saveConfig,
      getProviderModelOptions: getModelOptions,
      fetchModels,
      getAuthStatus: () => Promise.resolve({ success: true, mode: 'provider' }),
      getServerStatus: () => Promise.resolve({ running: false }),
      getSettings: () => Promise.resolve({ showCreate: false, host: '' }),
      getLogs: () => Promise.resolve([]),
      onServerStatus: () => () => {},
      onServerLog: () => () => {},
      windowIsMaximized: () => Promise.resolve(false),
      onWindowMaximizeChange: () => () => {},
      getAppUpdateStatus: () => Promise.resolve({ phase: 'disabled' }),
      onAppUpdateStatus: () => () => {},
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
async function render(
  props: Partial<Parameters<typeof ProviderManagementModal>[0]> = {},
) {
  await act(async () => {
    root.render(
      createElement(LanguageProvider, {
        children: createElement(ProviderManagementModal, {
          onClose: () => {},
          ...props,
        }),
      }),
    )
  })
}
function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === label,
  )
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}
async function selectMode(label: string) {
  const mode = [
    ...container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ].find((node) => node.firstElementChild?.textContent === label)
  if (!mode) throw new Error(`Missing mode: ${label}`)
  await act(async () => {
    mode.click()
  })
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

async function renderTokenUsageDashboard(
  summary: TokenUsageSummary,
  apiOverrides: Partial<typeof window.electronAPI> = {},
) {
  Object.assign(window.electronAPI, {
    getServerStatus: () => Promise.resolve({ running: true }),
    getServerAuthInfo: () => Promise.resolve({ enabled: false }),
    fetchTokenUsage: () => Promise.resolve(summary),
    fetchTokenUsageDaily: () => Promise.resolve({ ...summary, days: [] }),
    fetchTokenUsageEvents: () =>
      Promise.resolve({
        period: summary.period,
        range: summary.range,
        items: [],
        page: 1,
        page_size: 10,
        total: 0,
        total_pages: 1,
      }),
    fetchTokenUsageSessions: () =>
      Promise.resolve(emptyTokenUsageSessionsPage()),
    ...apiOverrides,
  })
  await act(async () => {
    root.render(
      createElement(LanguageProvider, {
        children: createElement(DashboardPage, {
          authMode: 'provider',
          defaultPort: 4141,
          defaultHost: '127.0.0.1',
          onChangeAuth: () => {},
        }),
      }),
    )
  })
  await act(async () => button('Token usage').click())
}

function createTokenUsageSummary(
  costs: TokenUsageSummary['totals']['costs'],
): TokenUsageSummary {
  const totals = {
    request_count: 10,
    input_tokens: 200,
    output_tokens: 9000,
    cache_read_input_tokens: 600,
    cache_creation_input_tokens: 200,
    costs,
    total_tokens: 10000,
  }
  return {
    period: 'today',
    range: { start_ms: 0, end_ms: 1, start_utc: '', end_utc: '' },
    totals,
    byModel: [{ ...totals, model: 'cached-model' }],
  }
}

function emptyTokenUsageSessionsPage(): TokenUsageSessionsPage {
  return {
    items: [],
    page: 1,
    page_size: 5,
    period: 'today' as const,
    range: { start_ms: 0, end_ms: 1, start_utc: '', end_utc: '' },
    total: 0,
    total_pages: 1,
  }
}

function createTokenUsageSessionsPage(
  summary: TokenUsageSummary,
  period: TokenUsagePeriod = 'today',
  page = 1,
): TokenUsageSessionsPage {
  return {
    ...emptyTokenUsageSessionsPage(),
    items: Array.from({ length: page === 1 ? 5 : 1 }, (_, index) => ({
      ...summary.totals,
      session_id: `${period}-session-${page === 1 ? index + 1 : 6}`,
    })),
    page,
    period,
    range: summary.range,
    total: 6,
    total_pages: 2,
  }
}

function sessionUsagePanel(): HTMLElement {
  const title = [...container.querySelectorAll('span')].find(
    (node) => node.textContent === 'Session breakdown',
  )
  const panel = title?.parentElement?.parentElement
  if (!panel) throw new Error('Missing session usage panel')
  return panel
}

async function changeTokenUsagePeriod(period: TokenUsagePeriod) {
  const select = container.querySelector('select')
  if (!select) throw new Error('Missing token usage period selector')
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(select),
      'value',
    )?.set?.call(select, period)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function leafDivTexts(): Array<string | null> {
  return [...container.querySelectorAll('div')]
    .filter((node) => node.childElementCount === 0)
    .map((node) => node.textContent)
}

describe('provider management UI', () => {
  test('shows token-weighted cache hit rates in the model breakdown', async () => {
    const totals = {
      request_count: 10,
      input_tokens: 200,
      output_tokens: 9000,
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: 200,
      costs: [
        { currency: 'USD', amount: 1.25, total_cost_nanos: 1_250_000_000 },
        { currency: 'CNY', amount: 9.5, total_cost_nanos: 9_500_000_000 },
      ],
      total_tokens: 10000,
    }
    const summary: TokenUsageSummary = {
      period: 'today',
      range: { start_ms: 0, end_ms: 1, start_utc: '', end_utc: '' },
      totals,
      byModel: [
        { ...totals, model: 'cached-model' },
        { ...totals, model: 'uncached-model', cache_read_input_tokens: 0 },
        {
          ...totals,
          model: 'empty-model',
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      ],
    }
    Object.assign(window.electronAPI, {
      getServerStatus: () => Promise.resolve({ running: true }),
      getServerAuthInfo: () => Promise.resolve({ enabled: false }),
      fetchTokenUsage: () => Promise.resolve(summary),
      fetchTokenUsageDaily: () => Promise.resolve({ ...summary, days: [] }),
      fetchTokenUsageEvents: () =>
        Promise.resolve({
          period: summary.period,
          range: summary.range,
          items: [],
          page: 1,
          page_size: 10,
          total: 0,
          total_pages: 1,
        }),
      fetchTokenUsageSessions: () =>
        Promise.resolve(emptyTokenUsageSessionsPage()),
    })
    await act(async () => {
      root.render(
        createElement(LanguageProvider, {
          children: createElement(DashboardPage, {
            authMode: 'provider',
            defaultPort: 4141,
            defaultHost: '127.0.0.1',
            onChangeAuth: () => {},
          }),
        }),
      )
    })
    await act(async () => button('Token usage').click())
    const metricLabel = [...container.querySelectorAll('div')].find(
      (node) =>
        node.childElementCount === 0 && node.textContent === 'Cache hit rate',
    )
    expect(metricLabel?.parentElement?.textContent).toBe('60.0%Cache hit rate')
    for (const [label, amount] of [
      ['Cost (USD)', '$1.250000'],
      ['Cost (CNY)', '¥9.500000'],
    ]) {
      const costLabel = [...container.querySelectorAll('div')].find(
        (node) => node.childElementCount === 0 && node.textContent === label,
      )
      expect(
        [...costLabel!.parentElement!.querySelectorAll('span')].map(
          (node) => node.textContent,
        ),
      ).toEqual([amount])
    }
    const table = container.querySelector('table')
    expect(
      [...table!.querySelectorAll('th')].map((node) => node.textContent),
    ).toEqual([
      'Model',
      'Requests',
      'Input',
      'Output',
      'Cache read',
      'Cache write',
      'Cache hit rate',
      'Total Tokens',
      'Total Cost',
    ])
    const rows = [...table!.querySelectorAll('tbody tr')]
    expect(
      rows.map((row) => row.querySelectorAll('td')[6].textContent),
    ).toEqual(['60.0%', '0.0%', '—'])
    expect(rows.every((row) => row.querySelectorAll('td').length === 9)).toBe(
      true,
    )
  })

  test('only shows cost metrics for currencies recorded in the summary', async () => {
    await renderTokenUsageDashboard(
      createTokenUsageSummary([
        { currency: 'USD', amount: 1.25, total_cost_nanos: 1_250_000_000 },
      ]),
    )

    const labels = leafDivTexts()
    expect(labels).toContain('Cost (USD)')
    expect(labels).not.toContain('Cost (CNY)')
  })

  test('falls back to a single cost metric when no costs are recorded', async () => {
    await renderTokenUsageDashboard(createTokenUsageSummary([]))

    const labels = leafDivTexts()
    expect(labels).toContain('Cost')
    expect(labels).not.toContain('Cost (USD)')
    expect(labels).not.toContain('Cost (CNY)')
    const costLabel = [...container.querySelectorAll('div')].find(
      (node) => node.childElementCount === 0 && node.textContent === 'Cost',
    )
    expect(costLabel?.parentElement?.textContent).toBe('—Cost')
  })

  test('pages session breakdown five rows at a time', async () => {
    const totals = {
      request_count: 2,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 5,
      costs: [{ currency: 'USD', amount: 0.5, total_cost_nanos: 500_000_000 }],
      total_tokens: 40,
    }
    const summary: TokenUsageSummary = {
      period: 'today',
      range: { start_ms: 0, end_ms: 1, start_utc: '', end_utc: '' },
      totals,
      byModel: [{ ...totals, model: 'cached-model' }],
    }
    const fetchTokenUsageSessions = mock(
      (_period: string, page: number, pageSize: number) =>
        Promise.resolve({
          items: Array.from({ length: page === 1 ? 5 : 1 }, (_, index) => ({
            ...totals,
            session_id: page === 1 ? 'session-' + (index + 1) : 'session-next',
          })),
          page,
          page_size: pageSize,
          period: 'today' as const,
          range: summary.range,
          total: 6,
          total_pages: 2,
        }),
    )
    Object.assign(window.electronAPI, {
      getServerStatus: () => Promise.resolve({ running: true }),
      getServerAuthInfo: () => Promise.resolve({ enabled: false }),
      fetchTokenUsage: () => Promise.resolve(summary),
      fetchTokenUsageDaily: () => Promise.resolve({ ...summary, days: [] }),
      fetchTokenUsageEvents: () =>
        Promise.resolve({
          period: summary.period,
          range: summary.range,
          items: [],
          page: 1,
          page_size: 10,
          total: 0,
          total_pages: 1,
        }),
      fetchTokenUsageSessions,
    })
    await act(async () => {
      root.render(
        createElement(LanguageProvider, {
          children: createElement(DashboardPage, {
            authMode: 'provider',
            defaultPort: 4141,
            defaultHost: '127.0.0.1',
            onChangeAuth: () => {},
          }),
        }),
      )
    })
    await act(async () => button('Token usage').click())

    expect(fetchTokenUsageSessions).toHaveBeenCalledWith('today', 1, 5)
    const sessionTable = [...container.querySelectorAll('table')].find(
      (node) => node.querySelector('th')?.textContent === 'Session',
    )
    expect(sessionTable).toBeDefined()
    expect(
      [...sessionTable!.querySelectorAll('tbody tr')].map(
        (row) => row.querySelector('td')?.textContent,
      ),
    ).toEqual(['session-1', 'session-2', 'session-3', 'session-4', 'session-5'])
    expect(container.textContent).toContain('Page 1 / 2')
    expect(container.textContent).toContain('6 sessions')

    const sessionHeader = [...container.querySelectorAll('span')].find(
      (node) => node.textContent === 'Session breakdown',
    )?.parentElement
    const next = [...(sessionHeader?.querySelectorAll('button') ?? [])].find(
      (node) => node.textContent === 'Next',
    )
    expect(next?.disabled).toBe(false)
    await act(async () => next?.click())
    expect(fetchTokenUsageSessions).toHaveBeenLastCalledWith('today', 2, 5)
    expect(
      [...sessionTable!.querySelectorAll('tbody tr')].map(
        (row) => row.querySelector('td')?.textContent,
      ),
    ).toEqual(['session-next'])
    expect(container.textContent).toContain('Page 2 / 2')

    const periodSelect = container.querySelector('select')
    expect(periodSelect).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(periodSelect),
        'value',
      )?.set?.call(periodSelect, 'this_week')
      periodSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(fetchTokenUsageSessions).toHaveBeenLastCalledWith('this_week', 1, 5)
  })

  test('clears old sessions on period changes and reports failure until a successful retry', async () => {
    const summary = createTokenUsageSummary([])
    const pending = Promise.withResolvers<unknown>()
    const fetchTokenUsageSessions = mock(
      (period: TokenUsagePeriod, page: number): Promise<unknown> =>
        Promise.resolve(createTokenUsageSessionsPage(summary, period, page)),
    )
    await renderTokenUsageDashboard(summary, { fetchTokenUsageSessions })
    expect(sessionUsagePanel().textContent).toContain('today-session-1')

    fetchTokenUsageSessions.mockReturnValueOnce(pending.promise)
    await changeTokenUsagePeriod('this_week')
    expect(fetchTokenUsageSessions).toHaveBeenLastCalledWith('this_week', 1, 5)
    expect(sessionUsagePanel().querySelector('table') === null).toBe(true)
    expect(sessionUsagePanel().textContent).toContain('Loading')

    await act(async () => pending.resolve(null))
    expect(sessionUsagePanel().querySelector('table') === null).toBe(true)
    expect(
      sessionUsagePanel().querySelector('[role="alert"]')?.textContent,
    ).toBe('Failed to load session usage. Click Refresh to retry.')
    expect(sessionUsagePanel().textContent).not.toContain(
      'No token usage recorded',
    )
    expect(button('Refresh').disabled).toBe(false)

    await act(async () => button('Refresh').click())
    expect(fetchTokenUsageSessions).toHaveBeenLastCalledWith('this_week', 1, 5)
    expect(sessionUsagePanel().querySelector('[role="alert"]') === null).toBe(
      true,
    )
    expect(sessionUsagePanel().textContent).toContain('this_week-session-1')
    expect(sessionUsagePanel().textContent).not.toContain('today-session-1')
  })

  test('clears existing sessions and reports errors when refreshing rejects', async () => {
    const summary = createTokenUsageSummary([])
    const fetchTokenUsageSessions = mock((): Promise<unknown> =>
      Promise.resolve(createTokenUsageSessionsPage(summary)),
    )
    await renderTokenUsageDashboard(summary, { fetchTokenUsageSessions })
    expect(sessionUsagePanel().textContent).toContain('today-session-1')

    fetchTokenUsageSessions.mockRejectedValueOnce(new Error('offline'))
    await act(async () => button('Refresh').click())
    expect(sessionUsagePanel().querySelector('table') === null).toBe(true)
    expect(sessionUsagePanel().querySelector('[role="alert"]')).not.toBeNull()
    expect(button('Refresh').disabled).toBe(false)
  })

  test.each(['unavailable', 'rejected'] as const)(
    'clears sessions after %s pagination and retries the requested page',
    async (failure) => {
      const summary = createTokenUsageSummary([])
      const fetchTokenUsageSessions = mock(
        (period: TokenUsagePeriod, page: number): Promise<unknown> =>
          Promise.resolve(createTokenUsageSessionsPage(summary, period, page)),
      )
      await renderTokenUsageDashboard(summary, { fetchTokenUsageSessions })
      const next = [...sessionUsagePanel().querySelectorAll('button')].find(
        (node) => node.textContent === 'Next',
      )
      expect(next?.disabled).toBe(false)
      if (failure === 'unavailable') {
        fetchTokenUsageSessions.mockResolvedValueOnce(null)
      } else {
        fetchTokenUsageSessions.mockRejectedValueOnce(new Error('offline'))
      }
      await act(async () => next!.click())
      expect(fetchTokenUsageSessions).toHaveBeenLastCalledWith('today', 2, 5)
      expect(sessionUsagePanel().querySelector('table') === null).toBe(true)
      expect(sessionUsagePanel().querySelector('[role="alert"]')).not.toBeNull()
      expect(button('Refresh').disabled).toBe(false)

      await act(async () => button('Refresh').click())
      expect(fetchTokenUsageSessions).toHaveBeenLastCalledWith('today', 2, 5)
      expect(sessionUsagePanel().querySelector('[role="alert"]') === null).toBe(
        true,
      )
      expect(sessionUsagePanel().textContent).toContain('today-session-6')
      expect(sessionUsagePanel().textContent).toContain('Page 2 / 2')
    },
  )

  test.each(['unavailable', 'rejected', 'success'] as const)(
    'ignores %s responses from an old session request after switching periods',
    async (result) => {
      const summary = createTokenUsageSummary([])
      const pending = Promise.withResolvers<unknown>()
      const fetchTokenUsageSessions = mock(
        (period: TokenUsagePeriod, page: number): Promise<unknown> =>
          period === 'this_week' ?
            pending.promise
          : Promise.resolve(
              createTokenUsageSessionsPage(summary, period, page),
            ),
      )
      await renderTokenUsageDashboard(summary, { fetchTokenUsageSessions })
      await changeTokenUsagePeriod('this_week')
      await changeTokenUsagePeriod('this_month')
      expect(sessionUsagePanel().textContent).toContain('this_month-session-1')

      await act(async () => {
        if (result === 'rejected') pending.reject(new Error('offline'))
        else
          pending.resolve(
            result === 'unavailable' ? null : (
              createTokenUsageSessionsPage(summary, 'this_week')
            ),
          )
      })
      expect(sessionUsagePanel().querySelector('[role="alert"]') === null).toBe(
        true,
      )
      expect(sessionUsagePanel().textContent).toContain('this_month-session-1')
      expect(sessionUsagePanel().textContent).not.toContain(
        'this_week-session-1',
      )
      expect(button('Refresh').disabled).toBe(false)
    },
  )

  test('shows Copilot percentages without rounding 99.9 percent to a full bar', async () => {
    const quota = {
      entitlement: 1500,
      remaining: 1499,
      quota_remaining: 0,
      percent_remaining: 99.9,
      unlimited: false,
    }
    Object.assign(window.electronAPI, {
      getAuthStatus: () => Promise.resolve({ success: true, mode: 'copilot' }),
      getServerStatus: () => Promise.resolve({ running: true }),
      getServerAuthInfo: () => Promise.resolve({ enabled: false }),
      fetchUsage: () =>
        Promise.resolve({
          quota_snapshots: {
            premium_interactions: quota,
            chat: quota,
            completions: { ...quota, unlimited: true },
          },
        }),
    })
    await act(async () => {
      root.render(
        createElement(LanguageProvider, {
          children: createElement(DashboardPage, {
            authMode: 'copilot',
            defaultPort: 4141,
            defaultHost: '127.0.0.1',
            onChangeAuth: () => {},
          }),
        }),
      )
    })
    expect(container.textContent).toContain('1 / 1500 · 0.1% used')
    expect(container.textContent).not.toContain('99.9% remaining')
    const quotaBar = (label: string) =>
      [...container.querySelectorAll('span')]
        .find((node) => node.textContent === label)
        ?.parentElement?.parentElement?.querySelector<HTMLDivElement>(
          'div[style]',
        )
    expect(parseFloat(quotaBar('Premium')!.style.width)).toBeCloseTo(0.1)
    expect(quotaBar('Chat')).toBeUndefined()
    expect(quotaBar('Completions')).toBeUndefined()
  })

  test('does not report the update installer stopping the server as a crash', async () => {
    let notify: ((status: ServerStatus) => void) | undefined
    let notifyUpdate: ((status: AppUpdateStatus) => void) | undefined
    const updateStatus: AppUpdateStatus = {
      phase: 'downloaded',
      currentVersion: '2.6.30',
      version: '2.6.31',
      manualInstall: false,
      releaseUrl:
        'https://github.com/caozhiyuan/copilot-api/releases/tag/v2.6.31',
    }
    Object.assign(window.electronAPI, {
      getServerStatus: () =>
        Promise.resolve({ running: true, port: 4141, host: '127.0.0.1' }),
      getServerAuthInfo: () => Promise.resolve({ enabled: false }),
      onServerStatus: (callback: (status: ServerStatus) => void) => {
        notify = callback
        return () => {
          notify = undefined
        }
      },
      getAppUpdateStatus: () => Promise.resolve(updateStatus),
      onAppUpdateStatus: (callback: (status: AppUpdateStatus) => void) => {
        notifyUpdate = callback
        return () => {
          notifyUpdate = undefined
        }
      },
      installAppUpdate: () => {
        const installing = { ...updateStatus, phase: 'installing' as const }
        notifyUpdate?.(installing)
        notify?.({ running: false, intentional: true })
        return Promise.resolve(installing)
      },
    })
    await act(async () => {
      root.render(
        createElement(LanguageProvider, {
          children: createElement(DashboardPage, {
            authMode: 'provider',
            defaultPort: 4141,
            defaultHost: '127.0.0.1',
            onChangeAuth: () => {},
          }),
        }),
      )
    })
    await act(async () => button('Restart and install').click())
    expect(container.textContent).toContain(
      'Stopping the server and installing…',
    )
    expect(container.textContent).not.toContain('Server stopped unexpectedly')
    expect(button('Start server')).toBeDefined()

    await act(async () => {
      notifyUpdate?.({ ...updateStatus, error: 'installer failed' })
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'installer failed',
    )
    expect(container.textContent).not.toContain('Server stopped unexpectedly')

    await act(async () => {
      notify?.({ running: true, port: 4141, host: '127.0.0.1' })
    })
    await act(async () => {
      notify?.({ running: false, error: 'Process exited with code 9' })
    })
    expect(container.textContent).toContain('Process exited with code 9')
  })

  test('preserves explicit errors even for an intentional stop', async () => {
    let notify: ((status: ServerStatus) => void) | undefined
    Object.assign(window.electronAPI, {
      getServerStatus: () => Promise.resolve({ running: true }),
      getServerAuthInfo: () => Promise.resolve({ enabled: false }),
      onServerStatus: (callback: (status: ServerStatus) => void) => {
        notify = callback
        return () => {
          notify = undefined
        }
      },
    })
    await act(async () => {
      root.render(
        createElement(LanguageProvider, {
          children: createElement(DashboardPage, {
            authMode: 'provider',
            defaultPort: 4141,
            defaultHost: '127.0.0.1',
            onChangeAuth: () => {},
          }),
        }),
      )
    })
    await act(async () => {
      notify?.({ running: false, intentional: true, error: 'stop failed' })
    })
    expect(container.textContent).toContain('stop failed')
  })

  test.each(['Logs', 'Token usage', 'Advanced config'])(
    'keeps the %s tab during an automatic restart',
    async (tabLabel) => {
      let notify: ((status: ServerStatus) => void) | undefined
      Object.assign(window.electronAPI, {
        getServerStatus: () =>
          Promise.resolve({ running: true, port: 4141, host: '127.0.0.1' }),
        getServerAuthInfo: () => Promise.resolve({ enabled: false }),
        getAppConfig: () =>
          Promise.resolve({
            configPath: 'config.json',
            content: '{}',
            revision: 'revision',
            defaultContent: '{}',
          }),
        onServerStatus: (callback: (status: ServerStatus) => void) => {
          notify = callback
          return () => {
            notify = undefined
          }
        },
      })
      await act(async () => {
        root.render(
          createElement(LanguageProvider, {
            children: createElement(DashboardPage, {
              authMode: 'provider',
              defaultPort: 4141,
              defaultHost: '127.0.0.1',
              onChangeAuth: () => {},
            }),
          }),
        )
      })
      await act(async () => button(tabLabel).click())
      if (tabLabel === 'Advanced config') {
        await act(async () => button('Model mappings').click())
        await act(async () => button('Add mapping').click())
        await changeText(
          container.querySelector<HTMLInputElement>('input')!,
          'draft-model',
        )
      }
      const activeTab = () =>
        container.querySelector('[role="tab"][aria-selected="true"]')
      expect(activeTab()?.textContent).toBe(tabLabel)
      const modelFetchCount = fetchModels.mock.calls.length

      await act(async () => {
        notify?.({ running: false, restarting: true })
      })
      expect(activeTab()?.textContent).toBe(tabLabel)
      expect(container.textContent).not.toContain('Server stopped unexpectedly')
      expect(container.textContent).not.toContain('Start server')
      expect(button('Restarting…').disabled).toBe(true)
      expect(button('Stop').disabled).toBe(true)
      expect(fetchModels).toHaveBeenCalledTimes(modelFetchCount)

      await act(async () => {
        notify?.({ running: true, port: 4141, host: '127.0.0.1' })
      })
      expect(activeTab()?.textContent).toBe(tabLabel)
      expect(button('Restart').disabled).toBe(false)
      expect(button('Stop').disabled).toBe(false)
      expect(fetchModels).toHaveBeenCalledTimes(modelFetchCount + 1)
      if (tabLabel === 'Advanced config') {
        expect(container.querySelector<HTMLInputElement>('input')?.value).toBe(
          'draft-model',
        )
      }
    },
  )

  test('reports a failed restart and recovers when the server starts again', async () => {
    let notify: ((status: ServerStatus) => void) | undefined
    Object.assign(window.electronAPI, {
      getServerStatus: () =>
        Promise.resolve({ running: true, port: 4141, host: '127.0.0.1' }),
      getServerAuthInfo: () => Promise.resolve({ enabled: false }),
      onServerStatus: (callback: (status: ServerStatus) => void) => {
        notify = callback
        return () => {
          notify = undefined
        }
      },
    })
    await act(async () => {
      root.render(
        createElement(LanguageProvider, {
          children: createElement(DashboardPage, {
            authMode: 'provider',
            defaultPort: 4141,
            defaultHost: '127.0.0.1',
            onChangeAuth: () => {},
          }),
        }),
      )
    })
    expect(button('Restart')).toBeDefined()
    await act(async () => {
      notify?.({ running: false, restarting: true })
    })
    await act(async () => {
      notify?.({ running: false, error: 'server stopped' })
    })
    expect(container.textContent).toContain('server stopped')
    expect(button('Start server')).toBeDefined()
    expect(container.textContent).not.toContain('Restarting…')
    await act(async () => {
      notify?.({ running: true, port: 4242, host: '0.0.0.0' })
    })
    expect(container.textContent).not.toContain('server stopped')
    expect(button('Restart')).toBeDefined()
    expect(button('Stop')).toBeDefined()
    expect(container.textContent).toContain('http://localhost:4242/v1')
    expect(
      [...container.querySelectorAll('button')].some(
        (node) => node.textContent === 'Start server',
      ),
    ).toBe(false)
    await act(async () => {
      notify?.({ running: false })
    })
    expect(container.textContent).toContain('Server stopped unexpectedly')
    expect(button('Start server')).toBeDefined()
  })

  test.each([true, false])(
    'keeps manual restart controls disabled until startup finishes (running=%s)',
    async (running) => {
      let notify: ((status: ServerStatus) => void) | undefined
      const pendingStart = Promise.withResolvers<ServerStatus>()
      Object.assign(window.electronAPI, {
        getServerStatus: () =>
          Promise.resolve({ running: true, port: 4141, host: '127.0.0.1' }),
        getServerAuthInfo: () => Promise.resolve({ enabled: false }),
        onServerStatus: (callback: (status: ServerStatus) => void) => {
          notify = callback
          return () => {
            notify = undefined
          }
        },
        stopServer: () => {
          notify?.({ running: false })
          return Promise.resolve()
        },
        startServer: () => pendingStart.promise,
      })
      await act(async () => {
        root.render(
          createElement(LanguageProvider, {
            children: createElement(DashboardPage, {
              authMode: 'provider',
              defaultPort: 4141,
              defaultHost: '127.0.0.1',
              onChangeAuth: () => {},
            }),
          }),
        )
      })
      await act(async () => button('Logs').click())
      await act(async () => button('Restart').click())
      expect(button('Restarting…').disabled).toBe(true)
      expect(button('Stop').disabled).toBe(true)
      expect(container.textContent).not.toContain('Server stopped unexpectedly')
      expect(
        container.querySelector('[role="tab"][aria-selected="true"]')
          ?.textContent,
      ).toBe('Logs')

      await act(async () => {
        pendingStart.resolve(
          running ?
            { running: true, port: 4141, host: '127.0.0.1' }
          : { running: false, error: 'startup failed' },
        )
      })
      if (running) {
        expect(button('Restart').disabled).toBe(false)
        expect(button('Stop').disabled).toBe(false)
      } else {
        expect(container.textContent).toContain('startup failed')
        expect(button('Start server')).toBeDefined()
      }
    },
  )

  test('uses current Copilot authorization when starting, restarting, and refreshing', async () => {
    const getAuthStatus = mock(() =>
      Promise.resolve({ success: true, mode: 'copilot' }),
    )
    const startServer = mock<typeof window.electronAPI.startServer>(() =>
      Promise.resolve({ running: true }),
    )
    const fetchUsage = mock(() =>
      Promise.resolve({ copilot_plan: 'copilot_pro' }),
    )
    Object.assign(window.electronAPI, {
      getAuthStatus,
      startServer,
      getServerAuthInfo: () => Promise.resolve({ enabled: false }),
      stopServer: () => Promise.resolve({ running: false }),
      fetchUsage,
    })
    await act(async () => {
      root.render(
        createElement(LanguageProvider, {
          children: createElement(DashboardPage, {
            authMode: 'provider',
            defaultPort: 4141,
            defaultHost: '127.0.0.1',
            onChangeAuth: () => {},
          }),
        }),
      )
    })
    await act(async () => {
      button('Start server').click()
    })
    expect(startServer).toHaveBeenCalledWith(4141, 'copilot', '127.0.0.1')
    expect(fetchUsage).toHaveBeenCalled()
    expect(container.textContent).toContain('copilot_pro')

    getAuthStatus.mockImplementation(() =>
      Promise.resolve({ success: true, mode: 'provider' }),
    )
    await act(async () => {
      button('Restart').click()
    })
    expect(startServer.mock.calls.at(-1)).toEqual([
      4141,
      'provider',
      '127.0.0.1',
    ])
    expect(container.textContent).not.toContain('copilot_pro')

    getAuthStatus.mockImplementation(() =>
      Promise.resolve({ success: true, mode: 'copilot' }),
    )
    await act(async () => {
      button('Refresh').click()
    })
    expect(container.textContent).toContain('copilot_pro')
  })

  test('allows provider management and advanced configuration while stopped', async () => {
    Object.assign(window.electronAPI, {
      getSettings: () =>
        Promise.resolve({ showCreate: true, host: '127.0.0.1' }),
    })
    await act(async () => {
      root.render(
        createElement(LanguageProvider, {
          children: createElement(DashboardPage, {
            authMode: 'provider',
            defaultPort: 4141,
            defaultHost: '127.0.0.1',
            onChangeAuth: () => {},
          }),
        }),
      )
    })
    const tabs = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ]
    const providersTab = tabs.find((tab) => tab.textContent === 'Providers')!
    const configTab = tabs.find((tab) =>
      tab.textContent?.toLowerCase().includes('advanced config'),
    )!
    const studioTab = tabs.find((tab) => tab.textContent === 'Create')!
    expect(providersTab.disabled).toBe(false)
    expect(configTab.disabled).toBe(false)
    expect(studioTab.disabled).toBe(false)
    await act(async () => {
      studioTab.click()
    })
    expect(container.querySelector('h1')?.textContent).toBe('Create')
    expect(container.textContent).toContain('Start the server to create media')
    const prompt = container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        win.HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(prompt, 'Keep this draft')
      prompt.dispatchEvent(new Event('input', { bubbles: true }))
      providersTab.click()
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelectorAll('nav button')).toHaveLength(2)
    expect(container.querySelector('h3')?.textContent).toBe('dashscope')
    expect(fetchModels).not.toHaveBeenCalled()
    expect(
      [...container.querySelectorAll('button')].filter(
        (node) => node.textContent === 'Providers',
      ),
    ).toHaveLength(1)
    await act(async () => studioTab.click())
    expect(container.querySelector('textarea')?.value).toBe('Keep this draft')
  })
  test('renders as a page and preserves edits when switching between providers', async () => {
    await act(async () => {
      root.render(
        createElement(LanguageProvider, {
          children: createElement(ProviderManagementPanel, {}),
        }),
      )
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('h4')?.textContent).toBe(
      'Models shown in Coding Agent',
    )
    expect(container.textContent).not.toContain('1 MiB')
    await selectMode('Selected models')
    await act(async () => {
      container
        .querySelector<HTMLInputElement>('[aria-label="dashscope: qwen-plus"]')!
        .click()
    })
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('nav button[aria-label="codex"]')!
        .click()
    })
    expect(container.querySelector('h3')?.textContent).toBe('codex')
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('nav button[aria-label="dashscope"]')!
        .click()
    })
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="dashscope: qwen-plus"]',
      )?.checked,
    ).toBe(true)
    await act(async () => {
      button('Save').click()
    })
    expect(saveConfig).toHaveBeenCalledWith({
      providers: { dashscope: { agentsModels: ['qwen-plus'] } },
    })
  })

  test('lists enabled providers before disabled ones', async () => {
    getConfig.mockImplementation(() =>
      Promise.resolve({
        configPath: 'config.json',
        providers: [
          {
            name: 'codex',
            type: 'openai-responses',
            enabled: false,
            agentsModels: [],
          },
          { name: 'dashscope', type: 'openai-compatible', enabled: true },
          { name: 'gemini', type: 'google', enabled: false },
        ],
      }),
    )
    await act(async () => {
      root.render(
        createElement(LanguageProvider, {
          children: createElement(ProviderManagementPanel, {}),
        }),
      )
    })
    const names = () =>
      [...container.querySelectorAll('nav button')].map((node) =>
        node.getAttribute('aria-label'),
      )
    expect(names()).toEqual(['dashscope', 'codex', 'gemini'])
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('nav button[aria-label="gemini"]')!
        .click()
    })
    await act(async () => {
      container.querySelector<HTMLInputElement>('[role="switch"]')!.click()
    })
    expect(names()).toEqual(['dashscope', 'gemini', 'codex'])
  })

  test('keeps selected models first while searching and preserves unknown selections', async () => {
    getConfig.mockImplementation(() =>
      Promise.resolve({
        ...fixture,
        providers: [
          {
            name: 'codex',
            type: 'openai-responses',
            enabled: true,
            agentsModels: ['unknown-model'],
          },
        ],
      }),
    )
    await render({ serverRunning: true })
    const modelOrder = () =>
      [
        ...container.querySelectorAll(
          'input[type="checkbox"]:not([role="switch"])',
        ),
      ].map((node) => node.getAttribute('aria-label'))
    expect(modelOrder()).toEqual([
      'codex: unknown-model',
      'codex: gpt-5.5',
      'codex: gpt-6.1-sol',
      'codex: live-model',
    ])
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="codex: unknown-model"]',
      )?.checked,
    ).toBe(true)
    await changeText(container.querySelector('input[type="search"]')!, 'live')
    expect(container.querySelector('[aria-label="codex: gpt-5.5"]')).toBeNull()
    await act(async () => {
      button('Select search results').click()
    })
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="codex: live-model"]',
      )?.checked,
    ).toBe(true)
    await changeText(container.querySelector('input[type="search"]')!, '')
    expect(modelOrder()).toEqual([
      'codex: live-model',
      'codex: unknown-model',
      'codex: gpt-5.5',
      'codex: gpt-6.1-sol',
    ])
    await act(async () => {
      container
        .querySelector<HTMLInputElement>('[aria-label="codex: gpt-5.5"]')!
        .click()
    })
    expect(modelOrder()).toEqual([
      'codex: gpt-5.5',
      'codex: live-model',
      'codex: unknown-model',
      'codex: gpt-6.1-sol',
    ])
    await act(async () => {
      button('Save').click()
    })
    expect(saveConfig).toHaveBeenCalledWith({
      providers: {
        codex: { agentsModels: ['unknown-model', 'live-model', 'gpt-5.5'] },
      },
    })
  })
  test('offers local models offline and falls back to manual IDs when loading fails', async () => {
    await render()
    expect(fetchModels).not.toHaveBeenCalled()
    await selectMode('Selected models')
    await act(async () => {
      container
        .querySelector<HTMLInputElement>('[aria-label="dashscope: qwen-plus"]')!
        .click()
    })
    expect(container.querySelector('textarea')?.value).toBe('qwen-plus')
    await act(async () => {
      button('Clear selection').click()
    })
    expect(container.querySelector('textarea')?.value).toBe('')
    getModelOptions.mockImplementation(() =>
      Promise.reject(new Error('Model list unavailable')),
    )
    await act(async () => {
      button('Save').click()
    })
    // Switch back to automatic so saving reloads the list without the empty-selection validation.
    await selectMode('Automatic')
    await act(async () => {
      button('Save').click()
    })
    expect(container.textContent).toContain('Could not load the model list')
  })
  test('edits a disabled provider and saves only changes without count or restart controls', async () => {
    await render({ serverRunning: true })
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('nav button[aria-label="codex"]')!
        .click()
    })
    const toggle = container.querySelector<HTMLInputElement>('[role="switch"]')!
    expect(toggle.checked).toBe(false)
    await act(async () => {
      toggle.click()
    })
    await selectMode('Selected models')
    await changeText(
      container.querySelector('textarea')!,
      'gpt-5.5\ngpt-6.1-sol',
    )
    expect(container.querySelector('input[type="number"]')).toBeNull()
    await act(async () => {
      button('Save').click()
    })
    expect(saveConfig).toHaveBeenCalledWith({
      providers: {
        codex: { enabled: true, agentsModels: ['gpt-5.5', 'gpt-6.1-sol'] },
      },
    })
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'refreshed its configuration',
    )
    expect(
      [...container.querySelectorAll('button')].some(
        (node) => node.textContent === 'Restart',
      ),
    ).toBe(false)
  })
  test('works offline with no providers and closes from the backdrop', async () => {
    getConfig.mockImplementation(() =>
      Promise.resolve({ ...fixture, providers: [] }),
    )
    const close = mock(() => {})
    await render({ onClose: close })
    expect(container.textContent).toContain('No providers configured')
    await act(async () => {
      button('Save').click()
    })
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Configuration saved.',
    )
    await act(async () => {
      ;(container.firstElementChild as HTMLElement).click()
    })
    expect(close).toHaveBeenCalledTimes(1)
  })
  test('reports load and save failures, and rejects an empty selected list', async () => {
    saveConfig.mockImplementation(() =>
      Promise.reject(new Error('Disk write failed')),
    )
    await render()
    await act(async () => {
      button('Save').click()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Disk write failed',
    )
    await selectMode('Selected models')
    await act(async () => {
      button('Save').click()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'model ID',
    )
    getConfig.mockImplementation(() => Promise.reject(new Error('Load failed')))
    await act(async () => {
      root.unmount()
    })
    const { createRoot } = await import('react-dom/client')
    root = createRoot(container)
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Load failed',
    )
    expect(button('Save').disabled).toBe(true)
  })
  test('does not close while saving and provides an accessible close button', async () => {
    let resolveSave: ((value: ProviderManagementConfig) => void) | undefined
    saveConfig.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        }),
    )
    const close = mock(() => {})
    await render({
      onClose: close,
      serverRunning: true,
    })
    await act(async () => {
      button('Save').click()
    })
    expect(container.querySelector('fieldset')?.disabled).toBe(true)
    await act(async () => {
      ;(container.firstElementChild as HTMLElement).click()
    })
    expect(close).not.toHaveBeenCalled()
    await act(async () => {
      resolveSave?.(fixture)
    })
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Close"]')!
        .click()
    })
    expect(close).toHaveBeenCalledTimes(1)
  })
})
