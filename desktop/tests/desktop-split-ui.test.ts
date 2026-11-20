import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

import {
  calcTokenTotal,
  EMPTY_TOKEN_USAGE_TOTALS,
  formatCellText,
  formatChartDate,
  formatEventTime,
  formatRefreshTime,
  formatTokenCount,
  getTrendTotals,
  MAX_LIFETIME_TREND_POINTS,
  maskSecret,
  sampleTrendDays,
} from '../src/components/dashboard/dashboard-format'
import { TokenUsageTrendChart } from '../src/components/dashboard/TokenUsageTrendChart'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import AuthPage from '../src/pages/AuthPage'
import type {
  AuthResult,
  TokenUsageDailySummary,
  TokenUsageModelSummary,
  TokenUsageTotals,
} from '../src/types/ipc'

import { createTestDom } from './helpers/dom'

let win: Window
let root: Root
let container: HTMLDivElement
let cleanupDom: () => Promise<void>

function makeTotals(
  overrides: Partial<TokenUsageTotals> = {},
): TokenUsageTotals {
  return {
    ...EMPTY_TOKEN_USAGE_TOTALS,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
    request_count: 2,
    total_tokens: 180,
    ...overrides,
  }
}

function makeModelSummary(
  totals: TokenUsageTotals,
  model: string,
): TokenUsageModelSummary {
  return {
    ...totals,
    average_first_token_ms: null,
    output_tokens_per_second: null,
    model,
  }
}

function makeDay(
  date: string,
  requestCount: number,
  model = 'gpt-5.6',
): TokenUsageDailySummary['days'][number] {
  const totals =
    requestCount > 0 ?
      makeTotals({
        request_count: requestCount,
        total_tokens: requestCount * 100,
      })
    : { ...EMPTY_TOKEN_USAGE_TOTALS }
  return {
    date,
    start_ms: 0,
    end_ms: 1,
    totals,
    byModel: requestCount > 0 ? [makeModelSummary(totals, model)] : [],
  }
}

beforeEach(async () => {
  ;({ win, root, container, cleanup: cleanupDom } = await createTestDom())
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  await cleanupDom()
})

describe('dashboard formatting and trend sampling helpers', () => {
  test('formats secrets, dates, counts, cells and samples lifetime trend points', () => {
    expect(maskSecret('ab')).toBe('****')
    expect(maskSecret('12345678')).toBe('********')
    expect(maskSecret('sk-1234567890abcd')).toBe('sk-1********abcd')

    expect(formatTokenCount(-5)).toBe('0')
    expect(calcTokenTotal(makeTotals())).toBe(180)
    expect(formatEventTime(0)).toBe('—')
    expect(formatEventTime(Date.UTC(2026, 5, 15, 12, 5, 9))).toContain('2026/')
    expect(formatRefreshTime(null)).toBe('—')
    expect(formatRefreshTime(Date.UTC(2026, 5, 15, 12, 5, 9))).toMatch(
      /^\d{2}:\d{2}:\d{2}$/,
    )
    expect(formatCellText('  ')).toBe('—')
    expect(formatCellText(' sess ')).toBe('sess')
    expect(formatChartDate('2026-06-15')).toBe('06/15')
    expect(formatChartDate('invalid')).toBe('invalid')

    const day = makeDay('2026-06-15', 2, 'gpt-5.6')
    expect(getTrendTotals(day, '__all__').request_count).toBe(2)
    expect(getTrendTotals(day, 'gpt-5.6').request_count).toBe(2)
    expect(getTrendTotals(day, 'missing-model').request_count).toBe(0)

    // Non-lifetime and short lifetime pass through unchanged
    const shortDays = [makeDay('2026-06-01', 1), makeDay('2026-06-02', 0)]
    expect(sampleTrendDays(shortDays, '__all__', 'last_7_days')).toBe(shortDays)
    expect(sampleTrendDays(shortDays, '__all__', 'lifetime')).toBe(shortDays)

    // Sparse lifetime (>180 days, fewer than 180 active usage days)
    const sparseDays = Array.from({ length: 240 }, (_, i) =>
      makeDay(
        `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
        i % 30 === 0 ? 1 : 0,
      ),
    )
    const sparseSampled = sampleTrendDays(sparseDays, '__all__', 'lifetime')
    expect(sparseSampled.length).toBeLessThanOrEqual(MAX_LIFETIME_TREND_POINTS)
    expect(sparseSampled.some((d) => d.totals.request_count > 0)).toBe(true)

    // Dense lifetime (>180 days, >=180 active usage days)
    const denseDays = Array.from({ length: 240 }, (_, i) =>
      makeDay(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, i + 1),
    )
    const denseSampled = sampleTrendDays(denseDays, '__all__', 'lifetime')
    expect(denseSampled).toHaveLength(MAX_LIFETIME_TREND_POINTS)
  })
})

describe('TokenUsageTrendChart component', () => {
  const t = ((key: string) => key) as Parameters<
    typeof TokenUsageTrendChart
  >[0]['t']

  test('renders loading, empty, interactive SVG chart, metric filter and model selector', async () => {
    const onModelChange = mock((_model: string) => {})

    // Loading state without data
    await act(async () => {
      root.render(
        createElement(TokenUsageTrendChart, {
          dailyUsage: null,
          loading: true,
          models: [],
          onModelChange,
          period: 'last_7_days',
          selectedModel: '__all__',
          t,
        }),
      )
    })
    expect(container.textContent).toContain('dashboard.loading')

    // Empty state
    await act(async () => {
      root.render(
        createElement(TokenUsageTrendChart, {
          dailyUsage: null,
          loading: false,
          models: [],
          onModelChange,
          period: 'last_7_days',
          selectedModel: '__all__',
          t,
        }),
      )
    })
    expect(container.textContent).toContain('dashboard.noTokenUsage')

    // Populated multi-day chart
    const days = [
      makeDay('2026-06-14', 1, 'gpt-5.6'),
      makeDay('2026-06-15', 3, 'gpt-5.6'),
    ]
    const dailyUsage: TokenUsageDailySummary = {
      period: 'last_7_days',
      range: { start_ms: 0, end_ms: 1, start_utc: '', end_utc: '' },
      totals: makeTotals(),
      byModel: [makeModelSummary(makeTotals(), 'gpt-5.6')],
      days,
    }

    await act(async () => {
      root.render(
        createElement(TokenUsageTrendChart, {
          dailyUsage,
          loading: false,
          models: dailyUsage.byModel,
          onModelChange,
          period: 'last_7_days',
          selectedModel: '__all__',
          t,
        }),
      )
    })

    expect(container.querySelector('svg[role="img"]')).not.toBeNull()
    const select = container.querySelector('select') as HTMLSelectElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(select),
        'value',
      )?.set?.call(select, 'gpt-5.6')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onModelChange).toHaveBeenCalledWith('gpt-5.6')

    // Click metric button and then All button
    const buttons = Array.from(container.querySelectorAll('button'))
    const inputBtn = buttons.find((b) =>
      b.textContent?.includes('dashboard.tokenUsageInput'),
    )
    const allBtn = buttons.find((b) => b.textContent?.trim() === 'All')
    await act(async () => {
      inputBtn?.click()
    })
    expect(container.querySelectorAll('polyline')).toHaveLength(1)
    await act(async () => {
      allBtn?.click()
    })
    expect(container.querySelectorAll('polyline')).toHaveLength(5)

    // Interact with day hit rect & circle
    const rect = container.querySelector('rect.cursor-pointer')
    const circle = container.querySelector('circle')
    await act(async () => {
      rect?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      circle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('06/14')
  })
})

describe('AuthPage provider input, manual token and GitHub device flow', () => {
  function setFieldValue(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    value: string,
  ) {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      'value',
    )?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }

  test('configures quick provider, custom models.dev provider, manual token and GitHub OAuth flow', async () => {
    const onSuccess = mock((_result: AuthResult) => {})
    const configureProvider = mock(() =>
      Promise.resolve({ success: true, mode: 'provider' as const }),
    )
    const saveToken = mock(() =>
      Promise.resolve({ success: true, mode: 'copilot' as const }),
    )
    const getModelsDevProviders = mock(() =>
      Promise.resolve([
        {
          id: 'openrouter-dev',
          name: 'OpenRouter Dev',
          type: 'openai-compatible' as const,
          api: 'https://openrouter.example/v1',
        },
      ]),
    )
    const openUrl = mock(() => Promise.resolve())
    const writeText = mock(() => Promise.resolve())
    let authSuccessHandler: ((result: AuthResult) => void) | undefined
    const getDeviceCode = mock(() =>
      Promise.resolve({
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
      }),
    )
    const onAuthSuccess = mock((cb: (result: AuthResult) => void) => {
      authSuccessHandler = cb
      return () => {}
    })

    Object.defineProperty(win.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(win, 'electronAPI', {
      configurable: true,
      value: {
        getSettings: () => Promise.resolve({ language: 'en' }),
        saveSettings: () => Promise.resolve(),
        getAuthStatus: () =>
          Promise.resolve({ authenticated: false, mode: 'none' }),
        getDeviceCode,
        onAuthSuccess,
        openUrl,
        saveToken,
        configureProvider,
        getModelsDevProviders,
        getCodexAccounts: () => Promise.resolve([]),
        getXaiAccounts: () => Promise.resolve([]),
        cancelCodexLogin: () => Promise.resolve(true),
        cancelXaiLogin: () => Promise.resolve(true),
        windowIsMaximized: () => Promise.resolve(false),
        onWindowMaximizeChange: () => () => {},
        getAppUpdateStatus: () => Promise.resolve({ phase: 'disabled' }),
        onAppUpdateStatus: () => () => {},
      },
    })

    await act(async () => {
      root.render(
        createElement(LanguageProvider, {
          children: createElement(AuthPage, { onSuccess }),
        }),
      )
    })

    const findButton = (text: string) =>
      Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes(text),
      )

    // 1. Select quick provider (DeepSeek) and save
    await act(async () => {
      findButton('DeepSeek')?.click()
    })
    const keyArea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      setFieldValue(keyArea, 'sk-deepseek-key')
    })
    await act(async () => {
      findButton('Confirm')?.click()
    })
    expect(configureProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'deepseek',
        apiKey: 'sk-deepseek-key',
      }),
    )
    expect(onSuccess).toHaveBeenCalledTimes(1)

    // Back to default, then select Custom provider + models.dev preset
    await act(async () => {
      findButton('Back')?.click()
    })
    await act(async () => {
      findButton('Custom provider')?.click()
    })
    expect(getModelsDevProviders).toHaveBeenCalledTimes(1)

    const selects = Array.from(container.querySelectorAll('select'))
    const modelsDevSelect = selects[0]
    const providerTypeSelect = selects[1]
    const authTypeSelect = selects[2]
    await act(async () => {
      setFieldValue(modelsDevSelect, 'openrouter-dev')
    })
    await act(async () => {
      setFieldValue(providerTypeSelect, 'anthropic')
      setFieldValue(authTypeSelect, 'x-api-key')
    })
    const customInputs = Array.from(container.querySelectorAll('input'))
    await act(async () => {
      setFieldValue(customInputs[0], 'custom-or')
      setFieldValue(customInputs[1], 'https://custom.example/v1')
      setFieldValue(
        container.querySelector('textarea') as HTMLTextAreaElement,
        'sk-custom',
      )
    })
    await act(async () => {
      findButton('Confirm')?.click()
    })
    expect(configureProvider).toHaveBeenLastCalledWith({
      provider: 'custom',
      name: 'custom-or',
      type: 'anthropic',
      baseUrl: 'https://custom.example/v1',
      apiKey: 'sk-custom',
      authType: 'x-api-key',
      modelsDevProviderId: 'openrouter-dev',
    })

    // Clearing models.dev selection resets fields cleanly
    await act(async () => {
      setFieldValue(modelsDevSelect, '')
    })

    // 2. Back to default and test Manual Token card
    await act(async () => {
      findButton('Back')?.click()
    })
    await act(async () => {
      findButton('Enter Copilot token manually')?.click()
    })
    const tokenArea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      setFieldValue(tokenArea, 'gho_testtoken123')
    })
    await act(async () => {
      findButton('Confirm')?.click()
    })
    expect(saveToken).toHaveBeenCalledWith('gho_testtoken123')

    // 3. Back to default and test GitHub device flow
    await act(async () => {
      findButton('Back')?.click()
    })
    await act(async () => {
      findButton('Sign in with GitHub')?.click()
    })
    expect(getDeviceCode).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('ABCD-1234')

    await act(async () => {
      findButton('Copy')?.click()
      findButton('Open authorization page')?.click()
    })
    expect(writeText).toHaveBeenCalledWith('ABCD-1234')
    expect(openUrl).toHaveBeenCalledWith('https://github.com/login/device')

    await act(async () => {
      authSuccessHandler?.({ success: true, mode: 'copilot' })
    })
    expect(onSuccess).toHaveBeenLastCalledWith({
      success: true,
      mode: 'copilot',
    })
  })
})
