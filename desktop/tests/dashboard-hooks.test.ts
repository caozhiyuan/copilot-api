import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, createElement } from 'react'
import { useServerLifecycle } from '../src/hooks/useServerLifecycle'
import { useTokenUsage } from '../src/hooks/useTokenUsage'
import { translate, type LocaleKey } from '../src/locales'
import type {
  ServerStatus,
  TokenUsageDailySummary,
  TokenUsageEventsPage,
  TokenUsageSessionsPage,
  TokenUsageSummary,
} from '../src/types/ipc'
import { createTestDom } from './helpers/dom'

let dom: Awaited<ReturnType<typeof createTestDom>>

const enTranslate = (key: LocaleKey, vars?: Record<string, string | number>) =>
  translate(key, 'en', vars)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const sampleSummary: TokenUsageSummary = {
  period: 'today',
  range: { start_ms: 0, end_ms: 1, start_utc: '', end_utc: '' },
  totals: {
    request_count: 2,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    costs: [],
    total_tokens: 150,
  },
  byModel: [],
}

const sampleDaily: TokenUsageDailySummary = {
  ...sampleSummary,
  days: [],
}

function makeEventsPage(page: number): TokenUsageEventsPage {
  return {
    items: [],
    page,
    page_size: 10,
    period: 'today',
    range: sampleSummary.range,
    total: 20,
    total_pages: 2,
  }
}

const sampleSessions: TokenUsageSessionsPage = {
  items: [],
  page: 1,
  page_size: 5,
  period: 'today',
  range: sampleSummary.range,
  total: 0,
  total_pages: 1,
}

beforeEach(async () => {
  dom = await createTestDom()
})

afterEach(async () => {
  await act(async () => dom.root.unmount())
  await dom.cleanup()
})

describe('useTokenUsage', () => {
  test('filters by API key, paginates events while discarding stale responses, and resets state', async () => {
    const firstEvents = deferred<TokenUsageEventsPage>()
    const secondEvents = deferred<TokenUsageEventsPage>()
    let eventsCall = 0

    const fetchTokenUsage = mock(() => Promise.resolve(sampleSummary))
    const fetchTokenUsageDaily = mock(() => Promise.resolve(sampleDaily))
    const fetchTokenUsageEvents = mock(() => {
      eventsCall += 1
      if (eventsCall === 1) return Promise.resolve(makeEventsPage(1))
      if (eventsCall === 2) return firstEvents.promise
      return secondEvents.promise
    })
    const fetchTokenUsageSessions = mock(() => Promise.resolve(sampleSessions))
    const getManagedApiKeys = mock(() => Promise.reject(new Error('offline')))

    Object.defineProperty(dom.win, 'electronAPI', {
      configurable: true,
      value: {
        fetchTokenUsage,
        fetchTokenUsageDaily,
        fetchTokenUsageEvents,
        fetchTokenUsageSessions,
        getManagedApiKeys,
      },
    })

    let latest!: ReturnType<typeof useTokenUsage>
    function Harness({
      isTokenUsageTab,
      serverActive,
    }: {
      isTokenUsageTab: boolean
      serverActive: boolean
    }) {
      latest = useTokenUsage({ isTokenUsageTab, serverActive })
      return null
    }

    await act(async () => {
      dom.root.render(
        createElement(Harness, { isTokenUsageTab: true, serverActive: true }),
      )
    })
    expect(getManagedApiKeys).toHaveBeenCalledTimes(1)

    await act(async () => {
      latest.handleApiKeyFilterChange('key-alpha')
    })
    expect(latest.apiKeyFilter).toBe('key-alpha')
    expect(fetchTokenUsage).toHaveBeenLastCalledWith('today', 'key-alpha')
    expect(latest.tokenUsage?.totals.total_tokens).toBe(150)

    await act(async () => {
      latest.handleTokenUsageEventsPageChange(2)
      latest.handleTokenUsageEventsPageChange(1)
    })

    await act(async () => {
      secondEvents.resolve(makeEventsPage(1))
    })
    expect(latest.tokenUsageEvents?.page).toBe(1)
    expect(latest.tokenUsageEventsLoading).toBe(false)

    await act(async () => {
      firstEvents.resolve(makeEventsPage(2))
    })
    // Stale page-2 response must not overwrite the newer page-1 response.
    expect(latest.tokenUsageEvents?.page).toBe(1)

    await act(async () => {
      latest.resetTokenUsageState()
    })
    expect(latest.tokenUsage).toBeNull()
    expect(latest.tokenUsageDaily).toBeNull()
    expect(latest.tokenUsageEvents).toBeNull()
    expect(latest.tokenUsageSettled).toBe(false)
  })
})

describe('useServerLifecycle', () => {
  test('validates port, handles start/stop/restart errors, and invokes onServerStopped', async () => {
    const startServer =
      mock<
        (
          port: number,
          authMode?: string,
          host?: string,
        ) => Promise<ServerStatus>
      >()
    const stopServer = mock(() => Promise.resolve())
    const getAuthStatus = mock(() =>
      Promise.resolve({ success: true, mode: 'provider' as const }),
    )
    const onServerStopped = mock(() => {})

    Object.defineProperty(dom.win, 'electronAPI', {
      configurable: true,
      value: {
        getServerStatus: () => Promise.resolve({ running: false }),
        onServerStatus: () => () => {},
        getServerAuthInfo: () => Promise.reject(new Error('unavailable')),
        getAuthStatus,
        startServer,
        stopServer,
      },
    })

    let latest!: ReturnType<typeof useServerLifecycle>
    function Harness() {
      latest = useServerLifecycle({
        defaultHost: '127.0.0.1',
        defaultPort: 4141,
        onServerStopped,
        t: enTranslate,
      })
      return null
    }

    await act(async () => {
      dom.root.render(createElement(Harness))
    })

    await act(async () => {
      latest.setPort('99999')
    })
    await act(async () => {
      await latest.handleStart()
    })
    expect(latest.startError).toBe(enTranslate('dashboard.invalidPort'))
    await act(async () => {
      await latest.handleRestart()
    })
    expect(startServer).not.toHaveBeenCalled()

    await act(async () => {
      latest.setPort('4141')
    })
    startServer.mockRejectedValueOnce(new Error('EADDRINUSE'))
    await act(async () => {
      await latest.handleStart()
    })
    expect(latest.startError).toBe('EADDRINUSE')
    expect(latest.started).toBe(false)

    startServer.mockResolvedValueOnce({ running: true, port: 4141 })
    await act(async () => {
      await latest.handleStart()
    })
    expect(latest.started).toBe(true)

    await act(async () => {
      await latest.handleStop()
    })
    expect(stopServer).toHaveBeenCalledTimes(1)
    expect(onServerStopped).toHaveBeenCalledTimes(1)
    expect(latest.started).toBe(false)

    startServer.mockRejectedValueOnce(new Error('restart boom'))
    await act(async () => {
      await latest.handleRestart()
    })
    expect(latest.startError).toBe('restart boom')
    expect(latest.started).toBe(false)
  })
})
