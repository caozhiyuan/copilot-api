import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

import SubscriptionQuotaCard, {
  SubscriptionQuotaDetails,
  SubscriptionQuotaSummary,
} from '../src/components/SubscriptionQuotaCard'
import SubscriptionsPage from '../src/pages/SubscriptionsPage'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import type { SubscriptionUsage } from '../src/types/ipc'

let win: Window
let root: Root
let container: HTMLDivElement
let fetchUsage: ReturnType<
  typeof mock<(provider: string) => Promise<SubscriptionUsage | null>>
>
const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
const business: SubscriptionUsage = {
  provider: 'codex',
  planType: 'business',
  limitReached: false,
  windows: [
    {
      id: 'spend',
      kind: 'spend',
      usedPercent: 32,
      used: 8000,
      limit: 25000,
      unit: 'credits',
      resetAt: 1793491200,
    },
  ],
  credits: {
    balance: 17000,
    hasCredits: true,
    unlimited: false,
    unit: 'credits',
  },
}

beforeEach(async () => {
  win = new Window({ url: 'http://localhost' })
  for (const [name, value] of Object.entries({
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    Event: win.Event,
    MouseEvent: win.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    })
  }
  fetchUsage = mock(() => Promise.resolve(structuredClone(business)))
  Object.defineProperty(win, 'electronAPI', {
    value: { fetchSubscriptionUsage: fetchUsage },
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

async function renderDetails(usage: SubscriptionUsage) {
  await act(async () =>
    root.render(
      createElement(
        LanguageProvider,
        null,
        createElement(SubscriptionQuotaDetails, { usage }),
      ),
    ),
  )
}
async function renderCard(
  provider: SubscriptionUsage['provider'] = 'codex',
  refreshKey: unknown = 0,
) {
  await act(async () =>
    root.render(
      createElement(
        LanguageProvider,
        null,
        createElement(SubscriptionQuotaCard, { provider, refreshKey }),
      ),
    ),
  )
}

describe('subscription quota details', () => {
  test('displays Copilot requests, unlimited windows and exact calendar reset dates', async () => {
    const usage: SubscriptionUsage = {
      provider: 'github-copilot',
      planType: 'individual',
      limitReached: false,
      windows: [
        {
          id: 'copilot:premium_interactions',
          kind: 'usage',
          name: 'Premium',
          used: 0,
          limit: 300,
          unit: 'requests',
          usedPercent: 0,
          resetDate: '2026-11-01',
        },
        { id: 'copilot:chat', kind: 'usage', name: 'Chat', unlimited: true },
      ],
    }
    fetchUsage.mockResolvedValue(usage)
    await renderCard('github-copilot')
    expect(container.textContent).toContain('GitHub Copilot')
    expect(container.textContent).toContain('100%')
    expect(container.textContent).toContain('0 / 300 requests')
    expect(container.textContent).toContain('resets 2026-11-01')
    expect(container.textContent).toContain('Unlimited')
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(1)
    expect(container.querySelector('img')?.getAttribute('src')).toStartWith(
      'data:image/svg+xml,',
    )
  })

  test('summarizes finite, unlimited and unknown balances without treating missing values as zero', async () => {
    const cases: Array<[SubscriptionUsage, string]> = [
      [
        {
          ...business,
          windows: [],
          credits: { unlimited: true, hasCredits: true, unit: 'credits' },
        },
        '∞',
      ],
      [
        {
          ...business,
          windows: [],
          credits: { unlimited: false, hasCredits: true, unit: 'credits' },
        },
        '—',
      ],
      [
        {
          ...business,
          windows: [],
          credits: {
            unlimited: false,
            hasCredits: true,
            balance: 12.5,
            unit: 'USD',
          },
        },
        '$12.50',
      ],
      [
        {
          ...business,
          credits: undefined,
          windows: [{ id: 'usage', kind: 'usage', usedPercent: 120 }],
        },
        '0%',
      ],
      [
        {
          ...business,
          credits: undefined,
          windows: [{ id: 'usage', kind: 'usage', usedPercent: -1 }],
        },
        '100%',
      ],
      [
        {
          ...business,
          credits: undefined,
          windows: [{ id: 'usage', kind: 'usage', unlimited: true }],
        },
        '∞',
      ],
      [{ ...business, credits: undefined, windows: [] }, '—'],
      [
        {
          ...business,
          credits: {
            unlimited: false,
            hasCredits: false,
            balance: 0,
            unit: 'credits',
          },
        },
        '68%',
      ],
    ]
    for (const [usage, text] of cases) {
      await act(async () =>
        root.render(
          createElement(
            LanguageProvider,
            null,
            createElement(SubscriptionQuotaSummary, { usage }),
          ),
        ),
      )
      expect(container.querySelector('.quota-summary-value')?.textContent).toBe(
        text,
      )
    }
  })
  test('renders Business monthly credit caps and balances without personal windows', async () => {
    await renderDetails(business)
    expect(container.textContent).toContain('Monthly credit limit')
    expect(container.textContent).toContain('8,000 / 25,000 Credits')
    expect(container.textContent).toContain('17,000')
    expect(container.textContent).toContain('32% used')
    expect(container.textContent).toContain('resets')
    expect(
      container
        .querySelector('[role="progressbar"]')
        ?.getAttribute('aria-valuenow'),
    ).toBe('32')
  })

  test('renders actual periods, named pools and clamps only the progress bar', async () => {
    await renderDetails({
      ...business,
      credits: undefined,
      windows: [
        {
          id: '5h',
          kind: 'usage',
          windowSeconds: 18000,
          usedPercent: 120,
          name: 'Codex Other',
          limitReached: true,
        },
        { id: 'weekly', kind: 'usage', windowSeconds: 604800, usedPercent: 0 },
        { id: 'month', kind: 'usage', period: 'monthly', usedPercent: 10 },
        { id: 'day', kind: 'usage', windowSeconds: 172800, usedPercent: -1 },
        { id: 'minute', kind: 'usage', windowSeconds: 1800, usedPercent: 4.25 },
        { id: 'unknown', kind: 'usage', limit: 20, unit: 'USD', resetAt: NaN },
        { id: 'on-demand', kind: 'on-demand', used: 3, limit: 50, unit: 'USD' },
      ],
    })
    expect(container.textContent).toContain('Codex Other · 5-hour limit')
    expect(container.textContent).toContain('Weekly limit')
    expect(container.textContent).toContain('Monthly limit')
    expect(container.textContent).toContain('2-day limit')
    expect(container.textContent).toContain('30-minute limit')
    expect(container.textContent).toContain('120% used')
    expect(container.textContent).toContain('4.3% used')
    expect(container.textContent).toContain('— / $20.00')
    expect(container.textContent).toContain('$3.00 / $50.00')
    expect(
      container
        .querySelector('[aria-label="Codex Other · 5-hour limit"]')
        ?.getAttribute('aria-valuenow'),
    ).toBe('100')
    expect(
      container
        .querySelector('[aria-label="2-day limit"]')
        ?.getAttribute('aria-valuenow'),
    ).toBe('0')
  })

  test('handles credits-only plans, zero balances, hidden balances, and empty reports', async () => {
    for (const [credits, expected] of [
      [{ unlimited: true, hasCredits: true, unit: 'credits' }, 'Unlimited'],
      [{ unlimited: false, hasCredits: true, unit: 'credits' }, 'Available'],
      [{ unlimited: false, hasCredits: false, unit: 'credits' }, '—'],
      [
        { unlimited: false, hasCredits: false, balance: 0, unit: 'USD' },
        '$0.00',
      ],
    ] as const) {
      await renderDetails({ ...business, windows: [], credits })
      expect(container.textContent).toContain(expected)
    }
    expect(container.textContent).toContain('Prepaid balance')
    await renderDetails({ ...business, windows: [], credits: undefined })
    expect(container.textContent).toContain('No quota details reported.')
  })

  test('shows specific workspace restrictions and generic limits', async () => {
    for (const [limitReason, message] of [
      ['workspace_owner_credits_depleted', 'Workspace credits are depleted'],
      ['workspace_member_credits_depleted', 'Workspace credits are depleted'],
      [
        'workspace_owner_usage_limit_reached',
        'Workspace spending limit reached',
      ],
      [
        'workspace_member_usage_limit_reached',
        'Workspace spending limit reached',
      ],
      ['rate_limit_reached', 'Usage limit reached'],
    ]) {
      await renderDetails({
        ...business,
        windows: [],
        credits: undefined,
        limitReached: true,
        limitReason,
      })
      expect(container.textContent).toContain(message)
    }
  })

  test('supports Chinese labels', async () => {
    Object.defineProperty(win.navigator, 'language', {
      value: 'zh-CN',
      configurable: true,
    })
    await renderDetails(business)
    expect(container.textContent).toContain('成员月度额度上限')
    expect(container.textContent).toContain('已用 32%')
  })
})

describe('subscriptions page', () => {
  async function renderPage(refreshKey: number, onManageProviders = () => {}) {
    await act(async () =>
      root.render(
        createElement(
          LanguageProvider,
          null,
          createElement(SubscriptionsPage, { refreshKey, onManageProviders }),
        ),
      ),
    )
  }

  test('offers provider management when no subscription provider is enabled', async () => {
    window.electronAPI.getProviderManagementConfig = mock(() =>
      Promise.resolve({
        configPath: 'config.json',
        providers: [
          { name: 'codex', type: 'openai-responses', enabled: false },
        ],
      }),
    )
    const manage = mock(() => {})
    await renderPage(0, manage)
    expect(container.textContent).toContain(
      'Your subscriptions will appear here',
    )
    expect(fetchUsage).not.toHaveBeenCalled()
    await act(async () => container.querySelector('button')?.click())
    expect(manage).toHaveBeenCalledTimes(1)
  })

  test('recovers from provider config failures through retry', async () => {
    const config = mock(() =>
      Promise.resolve({
        configPath: 'config.json',
        providers: [{ name: 'codex', type: 'openai-responses', enabled: true }],
      }),
    )
    config.mockRejectedValueOnce(new Error('unreadable config'))
    window.electronAPI.getProviderManagementConfig = config
    await renderPage(0)
    expect(container.textContent).toContain('Could not load')
    await act(async () => container.querySelector('button')?.click())
    expect(container.querySelectorAll('.quota-provider-card')).toHaveLength(1)
    expect(fetchUsage).toHaveBeenCalledTimes(1)
  })

  test('ignores late provider configs and errors after leaving the page', async () => {
    let resolve!: (value: { configPath: string; providers: [] }) => void
    let reject!: (error: Error) => void
    const config = mock(
      () =>
        new Promise<{ configPath: string; providers: [] }>((done) => {
          resolve = done
        }),
    )
    config.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        }),
    )
    window.electronAPI.getProviderManagementConfig = config
    await renderPage(0)
    await renderPage(1)
    await act(async () => reject(new Error('stale failure')))
    await act(async () => root.render(null))
    await act(async () => resolve({ configPath: 'config.json', providers: [] }))
    expect(container.textContent).toBe('')
    expect(fetchUsage).not.toHaveBeenCalled()
  })
})

describe('subscription quota loading', () => {
  test('loads, refreshes, and replaces stale data with error or unavailable states', async () => {
    await renderCard()
    expect(fetchUsage).toHaveBeenCalledWith('codex')
    expect(container.textContent).toContain('business')
    const refresh = container.querySelector('button')!
    fetchUsage.mockRejectedValueOnce(new Error('offline'))
    await act(async () => refresh.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not load quota',
    )
    expect(container.textContent).not.toContain('17,000')
    fetchUsage.mockResolvedValueOnce(null)
    await act(async () => refresh.click())
    expect(container.textContent).toContain(
      'No subscription account available.',
    )
  })

  test('ignores an old request after the provider or refresh key changes', async () => {
    let resolveOld!: (usage: SubscriptionUsage) => void
    fetchUsage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    await renderCard('codex', 1)
    expect(container.textContent).toContain('Loading')
    expect(container.querySelector('button')?.disabled).toBe(true)
    fetchUsage.mockResolvedValueOnce({
      provider: 'xai',
      windows: [],
      limitReached: false,
      planType: 'SuperGrok',
    })
    await renderCard('xai', 2)
    expect(container.textContent).toContain('xAI')
    expect(container.textContent).toContain('SuperGrok')
    await act(async () => resolveOld(business))
    expect(container.textContent).not.toContain('business')
  })

  test('ignores errors and completions after unmount', async () => {
    let reject!: (error: Error) => void
    fetchUsage.mockImplementationOnce(
      () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise
        }),
    )
    await renderCard()
    await act(async () => root.render(null))
    await act(async () => reject(new Error('late')))
    expect(container.textContent).toBe('')
  })
})
