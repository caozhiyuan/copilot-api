import { useEffect, useRef, useState } from 'react'
import type {
  GatewayApiKeyConfig,
  TokenUsageDailySummary,
  TokenUsageEventsPage,
  TokenUsagePeriod,
  TokenUsageSessionsPage,
  TokenUsageSummary,
} from '../types/ipc'

const TOKEN_USAGE_EVENTS_PAGE_SIZE = 10
const TOKEN_USAGE_SESSIONS_PAGE_SIZE = 5

interface UseTokenUsageOptions {
  isTokenUsageTab: boolean
  serverActive: boolean
}

export function useTokenUsage({
  isTokenUsageTab,
  serverActive,
}: UseTokenUsageOptions) {
  const [tokenUsage, setTokenUsage] = useState<TokenUsageSummary | null>(null)
  const [tokenUsageDaily, setTokenUsageDaily] =
    useState<TokenUsageDailySummary | null>(null)
  const [tokenUsageEvents, setTokenUsageEvents] =
    useState<TokenUsageEventsPage | null>(null)
  const [tokenUsageEventsPage, setTokenUsageEventsPage] = useState(1)
  const [tokenUsageSessions, setTokenUsageSessions] =
    useState<TokenUsageSessionsPage | null>(null)
  const [tokenUsageSessionsPage, setTokenUsageSessionsPage] = useState(1)
  const [tokenUsagePeriod, setTokenUsagePeriod] =
    useState<TokenUsagePeriod>('today')
  const [apiKeyFilter, setApiKeyFilter] = useState('')
  const apiKeyFilterRef = useRef('')
  const [managedApiKeys, setManagedApiKeys] = useState<GatewayApiKeyConfig[]>(
    [],
  )
  const [tokenUsageLoading, setTokenUsageLoading] = useState(false)
  const [tokenUsageSettled, setTokenUsageSettled] = useState(false)
  const [tokenUsageEventsLoading, setTokenUsageEventsLoading] = useState(false)
  const [tokenUsageSessionsLoading, setTokenUsageSessionsLoading] =
    useState(false)
  const [tokenUsageSessionsError, setTokenUsageSessionsError] = useState(false)

  const tokenUsageRequestId = useRef(0)
  const tokenUsageEventsRequestId = useRef(0)
  const tokenUsageSessionsRequestId = useRef(0)

  const apiKeyFilterArgs = (): [] | [string] =>
    apiKeyFilterRef.current ? [apiKeyFilterRef.current] : []

  const fetchTokenUsageEvents = async (
    period: TokenUsagePeriod,
    page: number,
  ) => {
    const requestId = ++tokenUsageEventsRequestId.current
    setTokenUsageEventsLoading(true)
    try {
      const tokenUsageEventsData =
        await window.electronAPI.fetchTokenUsageEvents(
          period,
          page,
          TOKEN_USAGE_EVENTS_PAGE_SIZE,
          ...apiKeyFilterArgs(),
        )
      if (
        requestId === tokenUsageEventsRequestId.current
        && tokenUsageEventsData
      ) {
        setTokenUsageEvents(tokenUsageEventsData as TokenUsageEventsPage)
      }
    } catch {
      // The server may still be initializing.
    } finally {
      if (requestId === tokenUsageEventsRequestId.current) {
        setTokenUsageEventsLoading(false)
      }
    }
  }

  const fetchTokenUsageSessions = async (
    period: TokenUsagePeriod,
    page: number,
  ) => {
    const requestId = ++tokenUsageSessionsRequestId.current
    setTokenUsageSessionsLoading(true)
    setTokenUsageSessionsError(false)
    try {
      const tokenUsageSessionsData =
        await window.electronAPI.fetchTokenUsageSessions(
          period,
          page,
          TOKEN_USAGE_SESSIONS_PAGE_SIZE,
          ...apiKeyFilterArgs(),
        )
      if (requestId === tokenUsageSessionsRequestId.current) {
        setTokenUsageSessions(
          tokenUsageSessionsData ?
            (tokenUsageSessionsData as TokenUsageSessionsPage)
          : null,
        )
        setTokenUsageSessionsError(!tokenUsageSessionsData)
      }
    } catch {
      if (requestId === tokenUsageSessionsRequestId.current) {
        setTokenUsageSessions(null)
        setTokenUsageSessionsError(true)
      }
    } finally {
      if (requestId === tokenUsageSessionsRequestId.current) {
        setTokenUsageSessionsLoading(false)
      }
    }
  }

  const fetchTokenUsageData = async (
    period: TokenUsagePeriod = tokenUsagePeriod,
    page: number = tokenUsageEventsPage,
    sessionsPage: number = tokenUsageSessionsPage,
  ) => {
    const requestId = ++tokenUsageRequestId.current
    const eventsRequestId = ++tokenUsageEventsRequestId.current
    setTokenUsageLoading(true)
    setTokenUsageEventsLoading(true)
    try {
      const [tokenUsageData, tokenUsageDailyData, tokenUsageEventsData] =
        await Promise.all([
          window.electronAPI.fetchTokenUsage(period, ...apiKeyFilterArgs()),
          window.electronAPI.fetchTokenUsageDaily(
            period,
            ...apiKeyFilterArgs(),
          ),
          window.electronAPI.fetchTokenUsageEvents(
            period,
            page,
            TOKEN_USAGE_EVENTS_PAGE_SIZE,
            ...apiKeyFilterArgs(),
          ),
          fetchTokenUsageSessions(period, sessionsPage),
        ])
      if (requestId === tokenUsageRequestId.current && tokenUsageData) {
        setTokenUsage(tokenUsageData as TokenUsageSummary)
      }
      if (requestId === tokenUsageRequestId.current && tokenUsageDailyData) {
        setTokenUsageDaily(tokenUsageDailyData as TokenUsageDailySummary)
      }
      if (
        eventsRequestId === tokenUsageEventsRequestId.current
        && tokenUsageEventsData
      ) {
        setTokenUsageEvents(tokenUsageEventsData as TokenUsageEventsPage)
      }
    } catch {
      // The server may still be initializing.
    } finally {
      if (requestId === tokenUsageRequestId.current) {
        setTokenUsageLoading(false)
        setTokenUsageSettled(true)
      }
      if (eventsRequestId === tokenUsageEventsRequestId.current) {
        setTokenUsageEventsLoading(false)
      }
    }
  }

  useEffect(() => {
    if (!isTokenUsageTab) return
    let active = true
    void (async () => {
      try {
        const keys = await window.electronAPI.getManagedApiKeys()
        if (active) setManagedApiKeys(keys)
      } catch {
        /* Global and unattributed views remain available. */
      }
    })()
    return () => {
      active = false
    }
  }, [isTokenUsageTab])

  const resetTokenUsageState = () => {
    setTokenUsage(null)
    setTokenUsageDaily(null)
    setTokenUsageEvents(null)
    setTokenUsageEventsPage(1)
    setTokenUsageSessions(null)
    setTokenUsageSessionsPage(1)
    setTokenUsageSessionsError(false)
    setTokenUsageLoading(false)
    setTokenUsageSettled(false)
    setTokenUsageEventsLoading(false)
    setTokenUsageSessionsLoading(false)
  }

  const handleApiKeyFilterChange = (value: string) => {
    apiKeyFilterRef.current = value
    setApiKeyFilter(value)
    setTokenUsageEventsPage(1)
    setTokenUsageSessionsPage(1)
    setTokenUsage(null)
    setTokenUsageDaily(null)
    setTokenUsageEvents(null)
    setTokenUsageSessions(null)
    if (serverActive) void fetchTokenUsageData(tokenUsagePeriod, 1, 1)
  }

  const handleTokenUsagePeriodChange = (nextPeriod: TokenUsagePeriod) => {
    setTokenUsagePeriod(nextPeriod)
    setTokenUsageEventsPage(1)
    tokenUsageSessionsRequestId.current += 1
    setTokenUsageSessions(null)
    setTokenUsageSessionsPage(1)
    setTokenUsageSessionsLoading(false)
    setTokenUsageSessionsError(false)
    if (serverActive) void fetchTokenUsageData(nextPeriod, 1, 1)
  }

  const handleTokenUsageEventsPageChange = (nextPage: number) => {
    setTokenUsageEventsPage(nextPage)
    if (serverActive) void fetchTokenUsageEvents(tokenUsagePeriod, nextPage)
  }

  const handleTokenUsageSessionsPageChange = (nextPage: number) => {
    setTokenUsageSessionsPage(nextPage)
    if (serverActive) void fetchTokenUsageSessions(tokenUsagePeriod, nextPage)
  }

  return {
    apiKeyFilter,
    fetchTokenUsageData,
    handleApiKeyFilterChange,
    handleTokenUsageEventsPageChange,
    handleTokenUsagePeriodChange,
    handleTokenUsageSessionsPageChange,
    isRefreshing:
      tokenUsageLoading || tokenUsageEventsLoading || tokenUsageSessionsLoading,
    managedApiKeys,
    resetTokenUsageState,
    tokenUsage,
    tokenUsageDaily,
    tokenUsageEvents,
    tokenUsageEventsLoading,
    tokenUsageEventsPage,
    tokenUsageLoading,
    tokenUsagePeriod,
    tokenUsageSessions,
    tokenUsageSessionsError,
    tokenUsageSessionsLoading,
    tokenUsageSettled,
  }
}
