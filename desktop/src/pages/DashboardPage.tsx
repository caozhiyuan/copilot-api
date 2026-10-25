import { useState, useEffect, useRef, type ReactNode } from 'react'

import Header from '../components/Header'
import SubscriptionsPage from './SubscriptionsPage'
import {
  TokenUsageCostMetric,
  TokenUsageMetric,
  TokenUsageValueLines,
} from '../components/TokenUsageMetric'
import { useLanguage } from '../contexts/LanguageContext'
import {
  formatCacheHitRate,
  formatLatency,
  formatOutputSpeed,
  formatTokenCost,
  formatTokenCosts,
} from '../lib/token-usage-format'
import { getProviderTypeLabel } from '../lib/provider-type-labels'
import { buildServerBaseUrl } from '../lib/server-url'
import AdvancedConfigPage from './AdvancedConfigPage'
import MediaStudioPage from './MediaStudioPage'
import ProviderManagementPanel from '../components/ProviderManagementPanel'
import type {
  DesktopAuthMode,
  ProviderManagementConfig,
  ServerAuthInfo,
  ServerStatus,
  TokenUsageDailySummary,
  TokenUsageEventRecord,
  TokenUsageEventsPage,
  TokenUsageModelSummary,
  TokenUsagePeriod,
  TokenUsageSessionSummary,
  TokenUsageSessionsPage,
  TokenUsageSummary,
  TokenUsageTotals,
} from '../types/ipc'

interface DashboardPageProps {
  authMode: DesktopAuthMode
  defaultPort: number
  defaultHost: string
  initialServerStatus?: ServerStatus
  initialTab?: 'dashboard' | 'providers'
  onChangeAuth: (returnTab: 'dashboard' | 'providers') => void
}

interface Model {
  id: string
  [key: string]: unknown
}

type TranslateFn = ReturnType<typeof useLanguage>['t']
type DashboardTab =
  | 'dashboard'
  | 'tokenUsage'
  | 'subscriptions'
  | 'providers'
  | 'advancedConfig'
  | 'studio'
  | 'logs'

/**
 * Tabs whose panel works without a running service and replaces the start form.
 * The tab reset, the start form and tab enablement all derive from these two
 * lists so a new tab cannot become visible-but-unclickable.
 */
const TABS_WITHOUT_START_FORM: ReadonlyArray<DashboardTab> = [
  'providers',
  'advancedConfig',
  'studio',
]
const TABS_REACHABLE_WHILE_STOPPED: ReadonlyArray<DashboardTab> = [
  'dashboard',
  ...TABS_WITHOUT_START_FORM,
]

const numberFormatter = new Intl.NumberFormat()
const TOKEN_USAGE_EVENTS_PAGE_SIZE = 10
const TOKEN_USAGE_SESSIONS_PAGE_SIZE = 5
const ALL_METRICS_VALUE = '__all__'
const ALL_MODELS_VALUE = '__all__'
const MAX_LIFETIME_TREND_POINTS = 180
const TOKEN_USAGE_PERIODS: TokenUsagePeriod[] = [
  'today',
  'this_week',
  'last_7_days',
  'this_month',
  'last_30_days',
  'lifetime',
]
const EMPTY_TOKEN_USAGE_TOTALS: TokenUsageTotals = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  costs: [],
  input_tokens: 0,
  output_tokens: 0,
  request_count: 0,
  total_tokens: 0,
}

const IconLaunch = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
    <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
    <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    <circle cx="15" cy="9" r="1" />
  </svg>
)

const IconRefresh = ({ spinning = false }: { spinning?: boolean }) => (
  <svg
    className={spinning ? 'animate-spin' : undefined}
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12a9 9 0 0 1-15.3 6.36" />
    <path d="M3 12A9 9 0 0 1 18.3 5.64" />
    <path d="M18 2v4h-4" />
    <path d="M6 22v-4h4" />
  </svg>
)

const IconDashboard = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </svg>
)

const IconTokenUsage = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 3v18h18" />
    <path d="M18 17V9" />
    <path d="M13 17V5" />
    <path d="M8 17v-3" />
  </svg>
)

const IconAdvancedConfig = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20 7h-9" />
    <path d="M14 17H5" />
    <circle cx="17" cy="17" r="3" />
    <circle cx="7" cy="7" r="3" />
  </svg>
)

const IconProviders = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8 3v4m8-4v4M6 7h12v3a6 6 0 0 1-12 0V7Zm6 9v5" />
  </svg>
)

const IconLogs = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m8 10 3 2-3 2" />
    <path d="M13 15h4" />
  </svg>
)

function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(Math.max(value.length, 4))
  return `${value.slice(0, 4)}********${value.slice(-4)}`
}

function formatTokenCount(value: number): string {
  return numberFormatter.format(Math.max(0, Math.floor(value)))
}

function padDatePart(value: number): string {
  return String(value).padStart(2, '0')
}

function calcTokenTotal(tokens: TokenUsageTotals): number {
  return tokens.total_tokens
}

function formatEventTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  const date = new Date(value)
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}:${padDatePart(date.getSeconds())}`
}

function formatRefreshTime(value: number | null): string {
  if (!value || !Number.isFinite(value)) return '—'
  const date = new Date(value)
  return `${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}:${padDatePart(date.getSeconds())}`
}

function getTokenUsagePeriodLabel(
  t: TranslateFn,
  period: TokenUsagePeriod,
): string {
  return {
    today: t('dashboard.tokenUsagePeriodToday'),
    this_week: t('dashboard.tokenUsagePeriodThisWeek'),
    last_7_days: t('dashboard.tokenUsagePeriodLast7Days'),
    this_month: t('dashboard.tokenUsagePeriodThisMonth'),
    last_30_days: t('dashboard.tokenUsagePeriodLast30Days'),
    lifetime: t('dashboard.tokenUsagePeriodLifetime'),
  }[period]
}

function formatCellText(value: string | null | undefined): string {
  const text = value?.trim()
  return text ? text : '—'
}

export default function DashboardPage({
  defaultPort,
  defaultHost,
  initialServerStatus,
  initialTab = 'dashboard',
  onChangeAuth,
}: DashboardPageProps) {
  const { t } = useLanguage()
  const [started, setStarted] = useState(initialServerStatus?.running ?? false)
  const [port, setPort] = useState<string>(
    String(initialServerStatus?.port ?? defaultPort),
  )
  const [host, setHost] = useState<string>(
    initialServerStatus?.host ?? defaultHost,
  )
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState(
    initialServerStatus && !initialServerStatus.running ?
      (initialServerStatus.error ?? t('dashboard.serverUnexpectedStop'))
    : '',
  )
  const [stopping, setStopping] = useState(false)
  const [restarting, setRestarting] = useState(false)

  const [tab, setTab] = useState<DashboardTab>(initialTab)
  const [advancedConfigOpened, setAdvancedConfigOpened] = useState(false)
  const [studioOpened, setStudioOpened] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  useEffect(() => {
    if (tab === 'advancedConfig') setAdvancedConfigOpened(true)
    if (tab === 'studio') setStudioOpened(true)
  }, [tab])
  useEffect(() => {
    let active = true
    void window.electronAPI
      .getSettings()
      .then((saved) => {
        if (active) setShowCreate(saved.showCreate === true)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  useEffect(() => {
    if (!showCreate) {
      if (tab === 'studio') setTab('dashboard')
      setStudioOpened(false)
    }
  }, [showCreate, tab])
  const [quotaRefreshKey, setQuotaRefreshKey] = useState(0)
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
  const [models, setModels] = useState<Model[]>([])
  const [providerConfig, setProviderConfig] =
    useState<ProviderManagementConfig | null>(null)
  const [serverAuthInfo, setServerAuthInfo] = useState<ServerAuthInfo>({
    enabled: false,
  })
  const [loading, setLoading] = useState(false)
  const [lastDashboardRefreshAt, setLastDashboardRefreshAt] = useState<
    number | null
  >(null)
  const [tokenUsageLoading, setTokenUsageLoading] = useState(false)
  const [tokenUsageEventsLoading, setTokenUsageEventsLoading] = useState(false)
  const [tokenUsageSessionsLoading, setTokenUsageSessionsLoading] =
    useState(false)
  const [tokenUsageSessionsError, setTokenUsageSessionsError] = useState(false)
  const [serverError, setServerError] = useState('')
  const [copied, setCopied] = useState<string>('')

  const [logs, setLogs] = useState<string[]>([])
  const logEndRef = useRef<HTMLDivElement>(null)
  const intentionalStop = useRef(false)
  useEffect(() => {
    if (!started && !TABS_REACHABLE_WHILE_STOPPED.includes(tab))
      setTab('dashboard')
  }, [started, tab])
  const tokenUsageRequestId = useRef(0)
  const tokenUsageEventsRequestId = useRef(0)
  const tokenUsageSessionsRequestId = useRef(0)

  const portNum = parseInt(port, 10)
  const normalizedHost = host.trim()
  const openaiUrl = `${buildServerBaseUrl(host, portNum)}/v1`
  const anthropicUrl = buildServerBaseUrl(host, portNum)

  useEffect(() => {
    let active = true

    window.electronAPI
      .getServerStatus()
      .then((status) => {
        if (!active) return
        // Only a running server reports the host and port it actually bound,
        // so an idle status must not overwrite the saved settings.
        if (status.running) {
          if (status.port) setPort(String(status.port))
          if (status.host !== undefined) setHost(status.host)
        }
        setStarted(status.running)
      })
      .catch(() => {})

    return () => {
      active = false
    }
  }, [])

  // Watch server status changes and only surface unexpected stops.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onServerStatus((status) => {
      if (status.restarting) {
        setRestarting(true)
        setStartError('')
        setServerError('')
        return
      }
      if (status.running) {
        setRestarting(false)
        if (status.port) setPort(String(status.port))
        if (status.host !== undefined) setHost(status.host)
        setStarted(true)
        setServerError('')
        intentionalStop.current = false
        return
      }
      if (!status.running) {
        if (!intentionalStop.current) {
          setRestarting(false)
          setServerError(
            status.error
              ?? (status.intentional ? '' : (
                t('dashboard.serverUnexpectedStop')
              )),
          )
          setStarted(false)
          void window.electronAPI
            .getLogs()
            .then(setLogs)
            .catch(() => {})
        }
        intentionalStop.current = false
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    void window.electronAPI
      .getLogs()
      .then(setLogs)
      .catch(() => {})
  }, [])

  // Subscribe to live logs.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onServerLog((log) => {
      setLogs((prev) => [...prev, log])
    })
    return unsubscribe
  }, [])

  // Auto-scroll the log view.
  useEffect(() => {
    if (tab === 'logs' || (!started && (startError || serverError))) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, tab, started, startError, serverError])

  // Fetch dashboard and token usage data after the server starts.
  useEffect(() => {
    if (started && !restarting) {
      void fetchData()
      void fetchTokenUsageData(tokenUsagePeriod, tokenUsageEventsPage)
    }
  }, [started, restarting])

  // The provider list can change on the Providers tab, so read it again
  // whenever the dashboard is shown.
  useEffect(() => {
    if (started && !restarting && tab === 'dashboard')
      void fetchProviderConfig()
  }, [started, restarting, tab])

  useEffect(() => {
    if (!started) {
      setServerAuthInfo({ enabled: false })
      return
    }
    if (restarting) return

    window.electronAPI
      .getServerAuthInfo()
      .then(setServerAuthInfo)
      .catch(() => {
        setServerAuthInfo({ enabled: false })
      })
  }, [started, restarting])

  const refreshAuthMode = async () => {
    const status = await window.electronAPI.getAuthStatus()
    return status.mode
  }

  const handleStart = async () => {
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setStartError(t('dashboard.invalidPort'))
      return
    }
    setStarting(true)
    setStartError('')
    setServerError('')
    setLogs([])
    try {
      const status = await window.electronAPI.startServer(
        portNum,
        await refreshAuthMode(),
        normalizedHost,
      )
      if (status.running) {
        setStarted(true)
      } else {
        setStartError(status.error ?? t('dashboard.serverUnexpectedStop'))
        void window.electronAPI
          .getLogs()
          .then(setLogs)
          .catch(() => {})
      }
    } catch (err) {
      setStartError((err as Error).message)
      void window.electronAPI
        .getLogs()
        .then(setLogs)
        .catch(() => {})
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    intentionalStop.current = true
    setStopping(true)
    await window.electronAPI.stopServer()
    setStopping(false)
    setStarted(false)
    setTokenUsage(null)
    setTokenUsageDaily(null)
    setTokenUsageEvents(null)
    setTokenUsageEventsPage(1)
    setTokenUsageSessions(null)
    setTokenUsageSessionsPage(1)
    setTokenUsageSessionsError(false)
    setTokenUsageLoading(false)
    setTokenUsageEventsLoading(false)
    setTokenUsageSessionsLoading(false)
    setModels([])
    setLastDashboardRefreshAt(null)
    setServerError('')
  }

  const handleRestart = async () => {
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setStartError(t('dashboard.invalidPort'))
      return
    }

    intentionalStop.current = true
    setRestarting(true)
    setStartError('')
    setServerError('')
    setLogs([])
    try {
      await window.electronAPI.stopServer()
      const status = await window.electronAPI.startServer(
        portNum,
        await refreshAuthMode(),
        normalizedHost,
      )
      if (status.running) {
        if (status.port) setPort(String(status.port))
        if (status.host !== undefined) setHost(status.host)
        setStarted(true)
      } else {
        setStarted(false)
        setTokenUsage(null)
        setTokenUsageDaily(null)
        setTokenUsageEvents(null)
        setTokenUsageEventsPage(1)
        setTokenUsageSessions(null)
        setTokenUsageSessionsPage(1)
        setTokenUsageSessionsError(false)
        setTokenUsageLoading(false)
        setTokenUsageEventsLoading(false)
        setTokenUsageSessionsLoading(false)
        setModels([])
        setLastDashboardRefreshAt(null)
        setStartError(status.error ?? t('dashboard.serverUnexpectedStop'))
        void window.electronAPI
          .getLogs()
          .then(setLogs)
          .catch(() => {})
      }
    } catch (err) {
      setStarted(false)
      setStartError((err as Error).message)
      void window.electronAPI
        .getLogs()
        .then(setLogs)
        .catch(() => {})
    } finally {
      setRestarting(false)
    }
  }

  const handleChangeAuth = () => {
    onChangeAuth(tab === 'providers' ? 'providers' : 'dashboard')
  }

  // The listening host is configured in the settings modal, so reload the
  // saved value once the modal closes.
  const handleSettingsClose = () => {
    void window.electronAPI
      .getSettings()
      .then((saved) => {
        if (saved.host !== undefined) setHost(saved.host)
        setShowCreate(saved.showCreate === true)
      })
      .catch(() => {})
  }

  const fetchData = async () => {
    setLoading(true)
    try {
      // Proxy HTTP requests through IPC so the main process bypasses renderer CORS.
      const modelsData = await window.electronAPI.fetchModels()
      if (modelsData) {
        const d = modelsData as { data: Model[] }
        setModels(d.data ?? [])
      }
      setLastDashboardRefreshAt(Date.now())
    } catch {
      // The server may still be initializing.
    } finally {
      setLoading(false)
    }
  }

  const fetchProviderConfig = async () => {
    try {
      setProviderConfig(await window.electronAPI.getProviderManagementConfig())
    } catch {
      // Keep the previous list when the config file cannot be read.
    }
  }

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
          window.electronAPI.fetchTokenUsage(period),
          window.electronAPI.fetchTokenUsageDaily(period),
          window.electronAPI.fetchTokenUsageEvents(
            period,
            page,
            TOKEN_USAGE_EVENTS_PAGE_SIZE,
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
      }
      if (eventsRequestId === tokenUsageEventsRequestId.current) {
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

  const handleTokenUsagePeriodChange = (nextPeriod: TokenUsagePeriod) => {
    setTokenUsagePeriod(nextPeriod)
    setTokenUsageEventsPage(1)
    tokenUsageSessionsRequestId.current += 1
    setTokenUsageSessions(null)
    setTokenUsageSessionsPage(1)
    setTokenUsageSessionsLoading(false)
    setTokenUsageSessionsError(false)
    if (started && !restarting) void fetchTokenUsageData(nextPeriod, 1, 1)
  }

  const handleTokenUsageEventsPageChange = (nextPage: number) => {
    setTokenUsageEventsPage(nextPage)
    if (started && !restarting)
      void fetchTokenUsageEvents(tokenUsagePeriod, nextPage)
  }

  const handleTokenUsageSessionsPageChange = (nextPage: number) => {
    setTokenUsageSessionsPage(nextPage)
    if (started && !restarting)
      void fetchTokenUsageSessions(tokenUsagePeriod, nextPage)
  }

  const handleRefreshActiveTab = () => {
    if (tab === 'dashboard') {
      void fetchData()
      void fetchProviderConfig()
      return
    }
    if (tab === 'subscriptions') {
      setQuotaRefreshKey((value) => value + 1)
      return
    }
    if (tab === 'tokenUsage') {
      void fetchTokenUsageData()
      return
    }
    void window.electronAPI
      .getLogs()
      .then(setLogs)
      .catch(() => {})
  }

  const handleCopy = (text: string, key: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(key)
        setTimeout(() => setCopied(''), 1500)
      })
      .catch(() => {})
  }

  const providers = providerConfig?.providers ?? []
  const shouldShowFailureLogs = !started && Boolean(startError || serverError)
  const enabledProviderCount = providers.filter((item) => item.enabled).length
  const shouldShowProviderOverview = providerConfig !== null
  const sortedProviders = [...providers].sort(
    (left, right) => Number(right.enabled) - Number(left.enabled),
  )
  const isActiveTabRefreshing =
    tab === 'dashboard' ? loading
    : tab === 'tokenUsage' ?
      tokenUsageLoading || tokenUsageEventsLoading || tokenUsageSessionsLoading
    : false
  const serverAuthHeaderName = serverAuthInfo.headerName ?? ''
  const serverAuthHeaderValue = serverAuthInfo.headerValue ?? ''
  const serverAuthHeader =
    serverAuthHeaderName && serverAuthHeaderValue ?
      `${serverAuthHeaderName}: ${serverAuthHeaderValue}`
    : ''
  const maskedServerAuthHeader =
    serverAuthHeaderName && serverAuthHeaderValue ?
      `${serverAuthHeaderName}: ${maskSecret(serverAuthHeaderValue)}`
    : ''

  const dashboardOverviewItems: Array<{
    label: string
    loading?: boolean
    tone: 'blue' | 'green' | 'slate'
    value: string
  }> = [
    {
      label: t('dashboard.overviewStatus'),
      tone: 'green',
      value:
        restarting ? t('header.restarting') : t('dashboard.overviewRunning'),
    },
    {
      label: t('dashboard.overviewPort'),
      tone: 'slate',
      value: String(portNum),
    },
    {
      label: t('dashboard.overviewModels'),
      loading,
      tone: 'blue',
      value: String(models.length),
    },
    {
      label: t('dashboard.overviewLastRefresh'),
      loading,
      tone: 'slate',
      value: formatRefreshTime(lastDashboardRefreshAt),
    },
  ]
  const dashboardTabs: Array<{
    icon: ReactNode
    key: DashboardTab
    label: string
  }> = [
    {
      icon: <IconDashboard />,
      key: 'dashboard',
      label: t('dashboard.tabDashboard'),
    },
    {
      icon: <IconTokenUsage />,
      key: 'tokenUsage',
      label: t('dashboard.tabTokenUsage'),
    },
    {
      icon: (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 19a9 9 0 1 1 14 0" />
          <path d="m12 13 4-5" />
          <path d="M8 20h8" />
        </svg>
      ),
      key: 'subscriptions',
      label: t('dashboard.tabSubscriptions'),
    },
    {
      icon: <IconProviders />,
      key: 'providers',
      label: t('providers.title'),
    },
    { icon: <IconLaunch />, key: 'studio', label: t('studio.title') },
    {
      icon: <IconAdvancedConfig />,
      key: 'advancedConfig',
      label: t('header.advancedConfig'),
    },
    { icon: <IconLogs />, key: 'logs', label: t('dashboard.tabLogs') },
  ]
  const visibleTabs = dashboardTabs.filter(
    (tabItem) => showCreate || tabItem.key !== 'studio',
  )
  const showRefreshButton =
    started
    && (tab === 'dashboard' || tab === 'tokenUsage' || tab === 'subscriptions')
  const showStartForm = !started && !TABS_WITHOUT_START_FORM.includes(tab)

  return (
    <div className="flex flex-col h-screen bg-canvas">
      <Header
        onChangeAuth={handleChangeAuth}
        onRestart={handleRestart}
        onStop={handleStop}
        onSettingsClose={handleSettingsClose}
        isRunning={started && !stopping}
        isRestarting={restarting}
      />

      {/* Unexpected server stop banner */}
      {serverError && (
        <div className="mx-4 mt-2 px-3 py-2 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg text-[13px] text-red-600 dark:text-red-400 flex items-center gap-1.5 shrink-0">
          <span>⚠️</span>
          <span>{serverError}</span>
        </div>
      )}

      {/* Providers, config and the create studio stay reachable while stopped. */}
      <div className="flex items-center justify-between gap-3 px-4 h-[52px] bg-surface border-b border-line-soft shrink-0">
        <div
          role="tablist"
          className="flex min-w-0 h-full items-stretch gap-1 overflow-x-auto sm:gap-3"
        >
          {visibleTabs.map((tabItem) => (
            <button
              key={tabItem.key}
              role="tab"
              aria-selected={tab === tabItem.key}
              disabled={
                !started && !TABS_REACHABLE_WHILE_STOPPED.includes(tabItem.key)
              }
              onClick={() => setTab(tabItem.key)}
              className={`inline-flex items-center gap-1.5 px-2 sm:px-3 text-[13px] whitespace-nowrap border-b-2 transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                tab === tabItem.key ?
                  'font-semibold text-ink border-accent'
                : 'text-ink-faint border-transparent hover:text-ink-soft'
              }`}
            >
              {tabItem.icon}
              {tabItem.label}
            </button>
          ))}
        </div>
        {showRefreshButton && (
          <button
            onClick={handleRefreshActiveTab}
            disabled={isActiveTabRefreshing || restarting}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[13px] text-ink-soft transition-colors hover:bg-sunken hover:text-ink disabled:opacity-40"
          >
            <IconRefresh spinning={isActiveTabRefreshing} />
            {isActiveTabRefreshing ?
              t('dashboard.refreshing')
            : tab === 'subscriptions' ?
              t('dashboard.quotaRefreshAll')
            : t('dashboard.refresh')}
          </button>
        )}
      </div>

      {/* Content area */}
      <div
        className={
          tab === 'providers' || tab === 'studio' ?
            'min-h-0 flex-1 overflow-hidden'
          : 'min-h-0 flex-1 overflow-auto'
        }
      >
        {/* Empty state: start form */}
        {showStartForm && (
          <div className="h-full flex flex-col items-center justify-center gap-4 px-6">
            <div className="w-11 h-11 bg-sunken rounded-xl flex items-center justify-center text-ink-soft dark:bg-[#4f94f8] dark:text-white">
              <IconLaunch />
            </div>
            <div className="text-center">
              <p className="text-[13px] font-semibold text-ink">
                {t('dashboard.serverStopped')}
              </p>
              <p className="text-[13px] text-ink-faint mt-1">
                {t('dashboard.configPort')}
              </p>
            </div>
            <div className="w-full max-w-[190px] bg-sunken border border-line rounded-xl p-3.5 flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-ink-soft">
                  {t('dashboard.port')}
                </span>
                <input
                  type="number"
                  value={port}
                  onChange={(e) => {
                    setPort(e.target.value)
                    setStartError('')
                  }}
                  min={1}
                  max={65535}
                  className="flex-1 bg-surface border border-line rounded-md py-1 px-2 text-[13px] font-semibold text-ink text-center focus:outline-none focus:ring-2 focus:ring-accent/40"
                />
              </div>
              {startError && (
                <p className="text-[13px] px-2 py-1.5 rounded-md bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-500/30">
                  ⚠️ {startError}
                </p>
              )}
              <button
                onClick={handleStart}
                disabled={starting}
                className="inline-flex w-full items-center justify-center gap-1.5 py-2 bg-accent-strong text-white text-[13px] font-semibold rounded-lg hover:bg-accent-strong/90 disabled:opacity-50 transition-colors"
              >
                <IconLaunch />
                {starting ?
                  t('dashboard.starting')
                : t('dashboard.startServer')}
              </button>
            </div>
            {shouldShowFailureLogs && (
              <div className="w-full max-w-2xl bg-black rounded-xl p-4 flex flex-col overflow-hidden min-h-0">
                <div className="flex items-center justify-between mb-3 shrink-0">
                  <span className="text-[13px] font-semibold text-ink-faint uppercase tracking-wide">
                    {t('dashboard.serverLog')}
                  </span>
                </div>
                <div className="max-h-60 overflow-y-auto font-mono text-[13px] text-green-400 space-y-0.5 leading-relaxed">
                  {logs.length === 0 ?
                    <span className="text-ink-soft">
                      {t('dashboard.noLogs')}
                    </span>
                  : logs.map((line, i) => (
                      <div key={i} className="whitespace-pre-wrap break-all">
                        {line.trimEnd()}
                      </div>
                    ))
                  }
                  <div ref={logEndRef} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Dashboard tab */}
        {started && tab === 'dashboard' && (
          <div className="flex h-full min-h-0 flex-col p-4">
            <div className="mb-2 grid shrink-0 grid-cols-2 gap-2 md:grid-cols-4">
              {dashboardOverviewItems.map((item) => (
                <div
                  key={item.label}
                  className="rounded-lg border border-line bg-sunken px-3 py-2"
                >
                  <div className="text-[13px] font-medium text-ink-faint">
                    {item.label}
                  </div>
                  <div
                    className={`mt-1 flex min-w-0 items-center gap-1.5 text-[13px] font-semibold ${
                      item.tone === 'green' ?
                        'text-green-600 dark:text-green-400'
                      : item.tone === 'blue' ? 'text-accent'
                      : 'text-ink'
                    } ${item.loading ? 'animate-pulse opacity-50' : ''}`}
                  >
                    {item.tone === 'green' && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
                    )}
                    <span className="truncate">
                      {item.loading ? '…' : item.value}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div className="grid min-h-0 flex-1 items-start gap-3 md:grid-cols-[minmax(0,1fr)_340px] md:grid-rows-[minmax(0,1fr)]">
              <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto md:h-full">
                {/* Provider overview */}
                {shouldShowProviderOverview && (
                  <div className="shrink-0 bg-surface border border-line rounded-xl p-3">
                    <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
                      <h3 className="text-[13px] font-semibold text-ink-faint uppercase tracking-wide">
                        {t('dashboard.providerOverview')}
                      </h3>
                      <div className="flex shrink-0 items-center gap-2 text-[13px]">
                        <span className="text-ink-faint">
                          {t('dashboard.providerOverviewSummary', {
                            enabled: enabledProviderCount,
                            total: providers.length,
                          })}
                        </span>
                        <button
                          onClick={() => setTab('providers')}
                          className="text-accent transition-opacity hover:opacity-70"
                        >
                          {t('dashboard.providerOverviewManage')}
                        </button>
                      </div>
                    </div>
                    <div className="h-[140px] space-y-1 overflow-y-auto">
                      {sortedProviders.map((provider) => (
                        <div
                          key={provider.name}
                          className="flex h-8 items-center gap-2 px-2.5 py-1.5 bg-sunken rounded-lg"
                        >
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              provider.enabled ? 'bg-green-500' : 'bg-line'
                            }`}
                          />
                          <span className="text-[13px] font-medium text-ink truncate">
                            {provider.name}
                          </span>
                          <span className="text-[13px] text-ink-faint truncate">
                            {getProviderTypeLabel(provider.type)}
                          </span>
                          {(provider.agentsModels?.length
                            || !provider.enabled) && (
                            <div className="ml-auto flex shrink-0 items-center gap-2 text-[13px] text-ink-faint">
                              {provider.agentsModels?.length ?
                                <span>
                                  {t('dashboard.providerOverviewModels', {
                                    n: provider.agentsModels.length,
                                  })}
                                </span>
                              : null}
                              {!provider.enabled && (
                                <span>{t('providers.disabled')}</span>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Service endpoints */}
                <div className="shrink-0 bg-surface border border-line rounded-xl p-3">
                  <h3 className="text-[13px] font-semibold text-ink-faint uppercase tracking-wide mb-2">
                    {t('dashboard.serviceAddress')}
                  </h3>
                  <div className="space-y-1.5">
                    {[
                      {
                        label: 'OpenAI',
                        url: openaiUrl,
                        key: 'openai',
                        color: 'bg-slate-500',
                      },
                      {
                        label: 'Anthropic',
                        url: anthropicUrl,
                        key: 'anthropic',
                        color: 'bg-violet-600',
                      },
                    ].map(({ label, url, key, color }) => (
                      <div
                        key={key}
                        className="flex items-center gap-2 px-2.5 py-1.5 bg-sunken rounded-lg"
                      >
                        <span
                          className={`text-[13px] font-semibold text-white ${color} rounded px-1.5 py-0.5 shrink-0`}
                        >
                          {label}
                        </span>
                        <span className="text-[13px] font-mono text-ink-soft truncate flex-1">
                          {url}
                        </span>
                        <button
                          onClick={() => handleCopy(url, key)}
                          className="shrink-0 text-[13px] text-accent hover:text-accent"
                        >
                          {copied === key ? '✓' : t('dashboard.copy')}
                        </button>
                      </div>
                    ))}
                  </div>
                  {serverAuthInfo.enabled
                    && serverAuthInfo.headerName
                    && serverAuthInfo.headerValue && (
                      <div className="mt-3 pt-3 border-t border-line-soft">
                        <h4 className="text-[13px] font-semibold text-ink-faint uppercase tracking-wide mb-1.5">
                          {t('dashboard.authHeader')}
                        </h4>
                        <div className="flex items-start gap-2 px-2.5 py-1.5 bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded-lg">
                          <span className="text-[13px] font-mono text-amber-900 dark:text-amber-400 break-all flex-1">
                            {maskedServerAuthHeader}
                          </span>
                          <button
                            onClick={() =>
                              handleCopy(serverAuthHeader, 'auth-header')
                            }
                            className="shrink-0 text-[13px] text-accent hover:text-accent"
                          >
                            {copied === 'auth-header' ?
                              '✓'
                            : t('dashboard.copy')}
                          </button>
                        </div>
                      </div>
                    )}
                </div>
              </div>

              <div className="flex min-h-0 min-w-0 flex-col gap-3 md:h-full">
                {/* Available models */}
                <div className="bg-surface border border-line rounded-xl p-3 flex max-h-[340px] flex-col overflow-hidden md:max-h-none md:min-h-0 md:flex-1">
                  <div className="flex items-center justify-between gap-2 mb-2 shrink-0">
                    <h3 className="text-[13px] font-semibold text-ink-faint uppercase tracking-wide">
                      {t('dashboard.availableModels')}
                    </h3>
                    {!loading && (
                      <span className="text-[13px] text-ink-faint shrink-0">
                        {t('dashboard.modelsCount', { n: models.length })}
                      </span>
                    )}
                  </div>
                  {loading ?
                    <p className="text-[13px] text-ink-faint animate-pulse">
                      {t('dashboard.loading')}
                    </p>
                  : models.length > 0 ?
                    <div className="flex-1 space-y-1 overflow-y-auto pr-1 min-h-0">
                      {models.map((m) => (
                        <div
                          key={m.id}
                          className="px-2.5 py-1 bg-sunken rounded-md text-[13px] text-ink-soft truncate"
                          title={m.id}
                        >
                          {m.id}
                        </div>
                      ))}
                    </div>
                  : <p className="text-[13px] text-ink-faint">
                      {t('dashboard.noModels')}
                    </p>
                  }
                </div>
              </div>
            </div>
          </div>
        )}

        {started && tab === 'subscriptions' && (
          <SubscriptionsPage
            refreshKey={quotaRefreshKey}
            onManageProviders={() => setTab('providers')}
          />
        )}

        {/* Token usage tab */}
        {started && tab === 'tokenUsage' && (
          <div className="p-4">
            <TokenUsagePanel
              dailyUsage={tokenUsageDaily}
              eventsPage={tokenUsageEvents}
              eventsLoading={tokenUsageEventsLoading}
              loading={tokenUsageLoading}
              onEventsPageChange={handleTokenUsageEventsPageChange}
              onSessionsPageChange={handleTokenUsageSessionsPageChange}
              period={tokenUsagePeriod}
              sessionsError={tokenUsageSessionsError}
              sessionsLoading={tokenUsageSessionsLoading}
              sessionsPage={tokenUsageSessions}
              tokenUsage={tokenUsage}
              onPeriodChange={handleTokenUsagePeriodChange}
              t={t}
            />
          </div>
        )}

        {tab === 'providers' && (
          <ProviderManagementPanel
            serverRunning={started && !stopping}
            onOpenAuthConfig={handleChangeAuth}
          />
        )}

        {showCreate && (tab === 'studio' || studioOpened) && (
          <div className={tab === 'studio' ? 'h-full' : 'hidden'}>
            <MediaStudioPage
              serverRunning={started && !stopping && !restarting}
            />
          </div>
        )}

        {/* Keep the editor mounted after opening it to preserve unsaved drafts. */}
        {(tab === 'advancedConfig' || advancedConfigOpened) && (
          <div className={tab === 'advancedConfig' ? 'h-full' : 'hidden'}>
            <AdvancedConfigPage
              active={tab === 'advancedConfig'}
              serverRunning={started && !stopping && !restarting}
            />
          </div>
        )}

        {/* Logs tab */}
        {started && tab === 'logs' && (
          <div className="p-4 h-full flex flex-col">
            <div className="flex-1 bg-black rounded-xl p-4 flex flex-col overflow-hidden min-h-0">
              <div className="flex items-center justify-between mb-3 shrink-0">
                <span className="text-[13px] font-semibold text-ink-faint uppercase tracking-wide">
                  {t('dashboard.serverLog')}
                </span>
                <button
                  onClick={() => setLogs([])}
                  className="text-[13px] text-ink-soft hover:text-ink-faint transition-colors"
                >
                  {t('dashboard.clear')}
                </button>
              </div>
              <div className="flex-1 overflow-y-auto font-mono text-[13px] text-green-400 space-y-0.5 leading-relaxed">
                {logs.length === 0 ?
                  <span className="text-ink-soft">{t('dashboard.noLogs')}</span>
                : logs.map((line, i) => (
                    <div key={i} className="whitespace-pre-wrap break-all">
                      {line.trimEnd()}
                    </div>
                  ))
                }
                <div ref={logEndRef} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Subcomponents

function TokenUsageSummaryMetrics({
  className,
  loading,
  t,
  totals,
}: {
  className: string
  loading: boolean
  t: TranslateFn
  totals: TokenUsageTotals
}) {
  const costCurrencies = [...new Set(totals.costs.map((cost) => cost.currency))]

  return (
    <div className={className}>
      <TokenUsageMetric
        label={t('dashboard.tokenUsageTotal')}
        value={formatTokenCount(calcTokenTotal(totals))}
        loading={loading}
        tone="slate"
      />
      <TokenUsageMetric
        label={t('dashboard.tokenUsageInput')}
        value={formatTokenCount(totals.input_tokens)}
        loading={loading}
        tone="blue"
      />
      <TokenUsageMetric
        label={t('dashboard.tokenUsageOutput')}
        value={formatTokenCount(totals.output_tokens)}
        loading={loading}
        tone="green"
      />
      <TokenUsageMetric
        label={t('dashboard.tokenUsageCacheRead')}
        value={formatTokenCount(totals.cache_read_input_tokens)}
        loading={loading}
        tone="cyan"
      />
      <TokenUsageMetric
        label={t('dashboard.tokenUsageCacheWrite')}
        value={formatTokenCount(totals.cache_creation_input_tokens)}
        loading={loading}
        tone="amber"
      />
      <TokenUsageMetric
        label={t('dashboard.tokenUsageCacheHitRate')}
        value={formatCacheHitRate(totals)}
        loading={loading}
        tone="cyan"
      />
      <TokenUsageMetric
        label={t('dashboard.tokenUsageRequests')}
        value={formatTokenCount(totals.request_count)}
        loading={loading}
        tone="violet"
      />
      {costCurrencies.length > 0 ?
        costCurrencies.map((currency) => (
          <TokenUsageCostMetric
            key={currency}
            label={`${t('dashboard.tokenUsageCost')} (${currency})`}
            value={formatTokenCost(
              totals.costs.find((cost) => cost.currency === currency),
            )}
            loading={loading}
          />
        ))
      : <TokenUsageCostMetric
          label={t('dashboard.tokenUsageCost')}
          value={formatTokenCosts(totals.costs)}
          loading={loading}
        />
      }
    </div>
  )
}

function TokenUsagePanel({
  dailyUsage,
  eventsPage,
  eventsLoading,
  loading,
  onEventsPageChange,
  onSessionsPageChange,
  onPeriodChange,
  period,
  sessionsError,
  sessionsLoading,
  sessionsPage,
  t,
  tokenUsage,
}: {
  dailyUsage: TokenUsageDailySummary | null
  eventsPage: TokenUsageEventsPage | null
  eventsLoading: boolean
  loading: boolean
  onEventsPageChange: (page: number) => void
  onSessionsPageChange: (page: number) => void
  onPeriodChange: (period: TokenUsagePeriod) => void
  period: TokenUsagePeriod
  sessionsError: boolean
  sessionsLoading: boolean
  sessionsPage: TokenUsageSessionsPage | null
  t: TranslateFn
  tokenUsage: TokenUsageSummary | null
}) {
  const [trendModel, setTrendModel] = useState(ALL_MODELS_VALUE)
  const [breakdownTab, setBreakdownTab] = useState<'models' | 'sessions'>(
    'models',
  )
  const totals = tokenUsage?.totals ?? EMPTY_TOKEN_USAGE_TOTALS
  const periods = TOKEN_USAGE_PERIODS.map((key) => ({
    key,
    label: getTokenUsagePeriodLabel(t, key),
  }))
  const trendModels = dailyUsage?.byModel ?? tokenUsage?.byModel ?? []
  const selectedTrendModel =
    trendModels.some((model) => model.model === trendModel) ? trendModel : (
      ALL_MODELS_VALUE
    )
  const hasModelRows = Boolean(tokenUsage && tokenUsage.byModel.length > 0)
  const hasEventRows = Boolean(eventsPage && eventsPage.items.length > 0)
  const hasSessionRows = Boolean(sessionsPage && sessionsPage.items.length > 0)

  return (
    <div className="bg-surface border border-line rounded-xl p-3">
      <div className="flex flex-col gap-2 mb-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-[13px] font-semibold text-ink-faint uppercase tracking-wide">
          {t('dashboard.tokenUsage')}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={period}
            onChange={(event) =>
              onPeriodChange(event.target.value as TokenUsagePeriod)
            }
            className="h-7 rounded-md border border-line bg-surface px-2 text-[13px] text-ink-soft focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            {periods.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <TokenUsageSummaryMetrics
        className="grid grid-cols-6 gap-2"
        loading={loading}
        t={t}
        totals={totals}
      />

      {period !== 'today' && (
        <TokenUsageTrendChart
          dailyUsage={dailyUsage}
          loading={loading}
          models={trendModels}
          onModelChange={setTrendModel}
          period={period}
          selectedModel={selectedTrendModel}
          t={t}
        />
      )}

      <div
        id="token-usage-breakdown"
        className="mt-3 overflow-hidden rounded-lg border border-line-soft"
      >
        <div className="flex flex-col gap-1.5 bg-sunken px-2.5 py-1.5 sm:flex-row sm:items-center sm:justify-between">
          <div
            role="tablist"
            aria-label={t('dashboard.tokenUsage')}
            className="flex items-center gap-1"
          >
            <button
              id="token-usage-model-tab"
              type="button"
              role="tab"
              aria-controls="token-usage-breakdown-panel"
              aria-selected={breakdownTab === 'models'}
              onClick={() => setBreakdownTab('models')}
              className={`rounded-md px-2 py-1 text-[13px] transition-colors ${
                breakdownTab === 'models' ?
                  'bg-surface font-semibold text-ink shadow-sm'
                : 'text-ink-faint hover:bg-surface/60 hover:text-ink-soft'
              }`}
            >
              {t('dashboard.tokenUsageModelBreakdown')}
            </button>
            <button
              id="token-usage-session-tab"
              type="button"
              role="tab"
              aria-controls="token-usage-breakdown-panel"
              aria-selected={breakdownTab === 'sessions'}
              onClick={() => setBreakdownTab('sessions')}
              className={`rounded-md px-2 py-1 text-[13px] transition-colors ${
                breakdownTab === 'sessions' ?
                  'bg-surface font-semibold text-ink shadow-sm'
                : 'text-ink-faint hover:bg-surface/60 hover:text-ink-soft'
              }`}
            >
              {t('dashboard.tokenUsageSessionBreakdown')}
            </button>
          </div>
          {breakdownTab === 'models' && tokenUsage && (
            <div className="flex items-center gap-2 text-[13px] text-ink-faint">
              <span>
                {t('dashboard.modelsCount', { n: tokenUsage.byModel.length })}
              </span>
              {loading && (
                <span className="text-ink-faint">{t('dashboard.loading')}</span>
              )}
            </div>
          )}
          {breakdownTab === 'sessions' && sessionsPage && (
            <div className="flex items-center gap-2 text-[13px] text-ink-faint">
              <span>
                {t('dashboard.tokenUsagePage', {
                  page: sessionsPage.page,
                  total: sessionsPage.total_pages,
                })}
              </span>
              <span>
                {t('dashboard.tokenUsageSessionsCount', {
                  n: sessionsPage.total,
                })}
              </span>
              {sessionsLoading && (
                <span className="text-ink-faint">{t('dashboard.loading')}</span>
              )}
              <button
                onClick={() =>
                  onSessionsPageChange(Math.max(1, sessionsPage.page - 1))
                }
                disabled={sessionsLoading || sessionsPage.page <= 1}
                className="h-7 rounded-md border border-line bg-surface px-2 text-[13px] text-ink-soft disabled:opacity-40"
              >
                {t('dashboard.previous')}
              </button>
              <button
                onClick={() =>
                  onSessionsPageChange(
                    Math.min(sessionsPage.total_pages, sessionsPage.page + 1),
                  )
                }
                disabled={
                  sessionsLoading
                  || sessionsPage.page >= sessionsPage.total_pages
                }
                className="h-7 rounded-md border border-line bg-surface px-2 text-[13px] text-ink-soft disabled:opacity-40"
              >
                {t('dashboard.next')}
              </button>
            </div>
          )}
        </div>
        <div
          id="token-usage-breakdown-panel"
          role="tabpanel"
          aria-labelledby={
            breakdownTab === 'models' ?
              'token-usage-model-tab'
            : 'token-usage-session-tab'
          }
          className="min-h-44"
        >
          {breakdownTab === 'models'
            && (loading && !tokenUsage ?
              <div className="flex h-[194px] items-start px-2.5 py-2 text-[13px] text-ink-faint animate-pulse">
                {t('dashboard.loading')}
              </div>
            : hasModelRows && tokenUsage ?
              <div
                className={`h-[194px] overflow-auto [scrollbar-gutter:stable] ${loading ? 'opacity-60' : ''}`}
              >
                <table className="w-full min-w-[1120px] table-fixed text-left text-[13px]">
                  <thead className="sticky top-0 bg-surface text-ink-faint">
                    <tr className="border-b border-line-soft">
                      <th className="w-[220px] px-2.5 py-1.5 font-semibold">
                        {t('dashboard.tokenUsageModel')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageRequests')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageInput')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageOutput')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageCacheRead')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageCacheWrite')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageCacheHitRate')}
                      </th>
                      <th
                        className="px-2.5 py-1.5 text-right font-semibold"
                        title={t('dashboard.tokenUsageTimingHint')}
                      >
                        {t('dashboard.tokenUsageAverageFirstToken')}
                      </th>
                      <th
                        className="px-2.5 py-1.5 text-right font-semibold"
                        title={t('dashboard.tokenUsageTimingHint')}
                      >
                        {t('dashboard.tokenUsageOutputSpeed')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageTotalTokens')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageTotalCost')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokenUsage.byModel.map((model) => (
                      <TokenUsageModelRow key={model.model} model={model} />
                    ))}
                  </tbody>
                </table>
              </div>
            : <div className="px-2.5 py-2 text-[13px] text-ink-faint">
                {t('dashboard.noTokenUsage')}
              </div>)}
          {breakdownTab === 'sessions'
            && (sessionsLoading && !sessionsPage ?
              <div className="flex h-[194px] items-start px-2.5 py-2 text-[13px] text-ink-faint animate-pulse">
                {t('dashboard.loading')}
              </div>
            : sessionsError ?
              <div
                role="alert"
                className="px-2.5 py-2 text-[13px] text-red-600 dark:text-red-400"
              >
                {t('dashboard.tokenUsageSessionsLoadFailed')}
              </div>
            : hasSessionRows && sessionsPage ?
              <div
                className={`h-[194px] overflow-auto [scrollbar-gutter:stable] ${sessionsLoading ? 'opacity-60' : ''}`}
              >
                <table className="w-full min-w-[960px] table-fixed text-left text-[13px]">
                  <thead className="sticky top-0 bg-surface text-ink-faint">
                    <tr className="border-b border-line-soft">
                      <th className="w-[280px] px-2.5 py-1.5 font-semibold">
                        {t('dashboard.tokenUsageSession')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageRequests')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageInput')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageOutput')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageCacheRead')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageCacheWrite')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageCacheHitRate')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageTotalTokens')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">
                        {t('dashboard.tokenUsageTotalCost')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessionsPage.items.map((session) => (
                      <TokenUsageSessionRow
                        key={session.session_id}
                        session={session}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            : <div className="px-2.5 py-2 text-[13px] text-ink-faint">
                {t('dashboard.noTokenUsage')}
              </div>)}
        </div>
      </div>
      <div className="mt-3 overflow-hidden rounded-lg border border-line-soft">
        <div className="flex flex-col gap-1.5 bg-sunken px-2.5 py-1.5 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-[13px] font-semibold text-ink-soft">
            {t('dashboard.tokenUsageEvents')}
          </span>
          {eventsPage && (
            <div className="flex items-center gap-2 text-[13px] text-ink-faint">
              <span>
                {t('dashboard.tokenUsagePage', {
                  page: eventsPage.page,
                  total: eventsPage.total_pages,
                })}
              </span>
              {eventsLoading && (
                <span className="text-ink-faint">{t('dashboard.loading')}</span>
              )}
              <button
                onClick={() =>
                  onEventsPageChange(Math.max(1, eventsPage.page - 1))
                }
                disabled={eventsLoading || eventsPage.page <= 1}
                className="h-7 rounded-md border border-line bg-surface px-2 text-[13px] text-ink-soft disabled:opacity-40"
              >
                {t('dashboard.previous')}
              </button>
              <button
                onClick={() =>
                  onEventsPageChange(
                    Math.min(eventsPage.total_pages, eventsPage.page + 1),
                  )
                }
                disabled={
                  eventsLoading || eventsPage.page >= eventsPage.total_pages
                }
                className="h-7 rounded-md border border-line bg-surface px-2 text-[13px] text-ink-soft disabled:opacity-40"
              >
                {t('dashboard.next')}
              </button>
            </div>
          )}
        </div>
        <div className="min-h-64">
          {eventsLoading && !eventsPage ?
            <div className="flex h-64 items-start px-2.5 py-2 text-[13px] text-ink-faint animate-pulse">
              {t('dashboard.loading')}
            </div>
          : hasEventRows && eventsPage ?
            <div
              className={`h-64 overflow-auto ${eventsLoading ? 'opacity-60' : ''}`}
            >
              <table className="w-full min-w-[1140px] text-left text-[13px]">
                <thead className="sticky top-0 bg-surface text-ink-faint">
                  <tr className="border-b border-line-soft">
                    <th className="px-2.5 py-1.5 font-semibold">
                      {t('dashboard.tokenUsageTime')}
                    </th>
                    <th className="px-2.5 py-1.5 font-semibold">
                      {t('dashboard.tokenUsageUser')}
                    </th>
                    <th className="px-2.5 py-1.5 font-semibold">
                      {t('dashboard.tokenUsageModel')}
                    </th>
                    <th className="px-2.5 py-1.5 font-semibold">
                      {t('dashboard.tokenUsageSession')}
                    </th>
                    <th className="px-2.5 py-1.5 font-semibold">
                      {t('dashboard.tokenUsageTrace')}
                    </th>
                    <th className="px-2.5 py-1.5 text-right font-semibold">
                      {t('dashboard.tokenUsageInput')}
                    </th>
                    <th className="px-2.5 py-1.5 text-right font-semibold">
                      {t('dashboard.tokenUsageOutput')}
                    </th>
                    <th className="px-2.5 py-1.5 text-right font-semibold">
                      {t('dashboard.tokenUsageCacheRead')}
                    </th>
                    <th className="px-2.5 py-1.5 text-right font-semibold">
                      {t('dashboard.tokenUsageCacheWrite')}
                    </th>
                    <th className="px-2.5 py-1.5 text-right font-semibold">
                      {t('dashboard.tokenUsageDuration')}
                    </th>
                    <th className="px-2.5 py-1.5 text-right font-semibold">
                      {t('dashboard.tokenUsageTotalTokens')}
                    </th>
                    <th className="px-2.5 py-1.5 text-right font-semibold">
                      {t('dashboard.tokenUsageTotalCost')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {eventsPage.items.map((event) => (
                    <TokenUsageEventRow key={event.id} event={event} />
                  ))}
                </tbody>
              </table>
            </div>
          : <div className="px-2.5 py-2 text-[13px] text-ink-faint">
              {t('dashboard.noTokenUsage')}
            </div>
          }
        </div>
      </div>
    </div>
  )
}

type TokenUsageTrendMetricKey =
  | 'cache_creation_input_tokens'
  | 'cache_read_input_tokens'
  | 'input_tokens'
  | 'output_tokens'
  | 'total_tokens'

function getTrendTotals(
  day: TokenUsageDailySummary['days'][number],
  selectedModel: string,
): TokenUsageTotals {
  if (selectedModel === ALL_MODELS_VALUE) return day.totals
  return (
    day.byModel.find((model) => model.model === selectedModel)
    ?? EMPTY_TOKEN_USAGE_TOTALS
  )
}

function sampleTrendDays(
  days: TokenUsageDailySummary['days'],
  selectedModel: string,
  period: TokenUsagePeriod,
): TokenUsageDailySummary['days'] {
  if (period !== 'lifetime' || days.length <= MAX_LIFETIME_TREND_POINTS) {
    return days
  }

  const usageIndexes = days.reduce<Array<number>>((indexes, day, index) => {
    if (getTrendTotals(day, selectedModel).request_count > 0) {
      indexes.push(index)
    }
    return indexes
  }, [])
  if (usageIndexes.length >= MAX_LIFETIME_TREND_POINTS) {
    const step = (usageIndexes.length - 1) / (MAX_LIFETIME_TREND_POINTS - 1)
    return Array.from(
      { length: MAX_LIFETIME_TREND_POINTS },
      (_, index) => days[usageIndexes[Math.round(index * step)]],
    )
  }

  const indexes = new Set(usageIndexes)
  const sampleCount = Math.max(
    1,
    MAX_LIFETIME_TREND_POINTS - usageIndexes.length,
  )
  const step = (days.length - 1) / (sampleCount - 1 || 1)
  for (let index = 0; index < sampleCount; index += 1) {
    indexes.add(Math.round(index * step))
  }
  return [...indexes]
    .sort((left, right) => left - right)
    .slice(0, MAX_LIFETIME_TREND_POINTS)
    .map((index) => days[index])
}

function formatChartDate(value: string): string {
  const [, month, day] = value.split('-')
  return month && day ? `${month}/${day}` : value
}

function TokenUsageTrendChart({
  dailyUsage,
  loading,
  models,
  onModelChange,
  period,
  selectedModel,
  t,
}: {
  dailyUsage: TokenUsageDailySummary | null
  loading: boolean
  models: TokenUsageModelSummary[]
  onModelChange: (model: string) => void
  period: TokenUsagePeriod
  selectedModel: string
  t: TranslateFn
}) {
  const [activeDayIndex, setActiveDayIndex] = useState<number | null>(null)
  const [selectedMetric, setSelectedMetric] =
    useState<string>(ALL_METRICS_VALUE)
  const metrics: Array<{
    color: string
    key: TokenUsageTrendMetricKey
    label: string
  }> = [
    {
      color: 'var(--color-accent)',
      key: 'total_tokens',
      label: t('dashboard.tokenUsageTotal'),
    },
    {
      color: '#2563eb',
      key: 'input_tokens',
      label: t('dashboard.tokenUsageInput'),
    },
    {
      color: '#16a34a',
      key: 'output_tokens',
      label: t('dashboard.tokenUsageOutput'),
    },
    {
      color: '#0891b2',
      key: 'cache_read_input_tokens',
      label: t('dashboard.tokenUsageCacheRead'),
    },
    {
      color: '#d97706',
      key: 'cache_creation_input_tokens',
      label: t('dashboard.tokenUsageCacheWrite'),
    },
  ]
  const visibleMetrics =
    selectedMetric === ALL_METRICS_VALUE ? metrics : (
      metrics.filter((metric) => metric.key === selectedMetric)
    )
  const days = sampleTrendDays(dailyUsage?.days ?? [], selectedModel, period)
  const hasUsage = days.some(
    (day) => getTrendTotals(day, selectedModel).request_count > 0,
  )
  const latestUsageIndex = days.reduce((latest, day, index) => {
    return getTrendTotals(day, selectedModel).request_count > 0 ? index : latest
  }, -1)
  const selectedDayIndex =
    (
      activeDayIndex !== null
      && activeDayIndex >= 0
      && activeDayIndex < days.length
    ) ?
      activeDayIndex
    : latestUsageIndex >= 0 ? latestUsageIndex
    : Math.max(0, days.length - 1)
  const selectedDay = days[selectedDayIndex]
  const selectedDayTotals =
    selectedDay ?
      getTrendTotals(selectedDay, selectedModel)
    : EMPTY_TOKEN_USAGE_TOTALS
  const width = 720
  const height = 220
  const padding = { bottom: 34, left: 54, right: 16, top: 16 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const maxValue = Math.max(
    1,
    ...days.flatMap((day) => {
      const totals = getTrendTotals(day, selectedModel)
      return visibleMetrics.map((metric) => totals[metric.key])
    }),
  )
  const xForIndex = (index: number): number => {
    if (days.length <= 1) return padding.left + plotWidth / 2
    return padding.left + (plotWidth * index) / (days.length - 1)
  }
  const hitWidth = days.length <= 1 ? plotWidth : plotWidth / (days.length - 1)
  const yForValue = (value: number): number =>
    padding.top + plotHeight - (Math.max(0, value) / maxValue) * plotHeight
  const labelEvery = Math.max(1, Math.ceil(days.length / 6))
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) =>
    Math.round(maxValue * ratio),
  )

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-line-soft">
      <div className="flex flex-col gap-1.5 bg-sunken px-2.5 py-1.5 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-[13px] font-semibold text-ink-soft">
          {t('dashboard.tokenUsageTrend')}
        </span>
        <select
          value={selectedModel}
          onChange={(event) => onModelChange(event.target.value)}
          className="h-7 rounded-md border border-line bg-surface px-2 text-[13px] text-ink-soft focus:outline-none focus:ring-2 focus:ring-accent/30"
        >
          <option value={ALL_MODELS_VALUE}>
            {t('dashboard.tokenUsageAllModels')}
          </option>
          {models.map((model) => (
            <option key={model.model} value={model.model}>
              {model.model}
            </option>
          ))}
        </select>
      </div>
      <div className="min-h-64 px-2.5 py-2">
        {loading && !dailyUsage ?
          <div className="flex h-56 items-start text-[13px] text-ink-faint animate-pulse">
            {t('dashboard.loading')}
          </div>
        : !dailyUsage || days.length === 0 || !hasUsage ?
          <div className="text-[13px] text-ink-faint">
            {t('dashboard.noTokenUsage')}
          </div>
        : <div className={`${loading ? 'opacity-60' : ''}`}>
            <svg
              className="h-56 w-full"
              viewBox={`0 0 ${width} ${height}`}
              role="img"
            >
              {yTicks.map((tick, index) => {
                const y = yForValue(tick)
                return (
                  <g key={`${tick}-${index}`}>
                    <line
                      x1={padding.left}
                      x2={width - padding.right}
                      y1={y}
                      y2={y}
                      stroke="var(--color-line)"
                      strokeWidth="1"
                    />
                    <text
                      x={padding.left - 8}
                      y={y + 4}
                      textAnchor="end"
                      fontSize="11"
                      fill="var(--color-ink-faint)"
                    >
                      {formatTokenCount(tick)}
                    </text>
                  </g>
                )
              })}
              {days.map((day, index) => {
                if (index % labelEvery !== 0 && index !== days.length - 1)
                  return null
                const x = xForIndex(index)
                return (
                  <text
                    key={day.date}
                    x={x}
                    y={height - 10}
                    textAnchor="middle"
                    fontSize="11"
                    fill="var(--color-ink-faint)"
                  >
                    {formatChartDate(day.date)}
                  </text>
                )
              })}
              {selectedDay && (
                <line
                  x1={xForIndex(selectedDayIndex)}
                  x2={xForIndex(selectedDayIndex)}
                  y1={padding.top}
                  y2={padding.top + plotHeight}
                  stroke="var(--color-line)"
                  strokeDasharray="4 4"
                  strokeWidth="1"
                />
              )}
              {days.map((day, index) => {
                const x = xForIndex(index)
                const hitStart = Math.max(padding.left, x - hitWidth / 2)
                const hitEnd = Math.min(width - padding.right, x + hitWidth / 2)
                return (
                  <rect
                    key={`${day.date}-hit`}
                    className="cursor-pointer"
                    fill="transparent"
                    height={plotHeight}
                    onClick={() => setActiveDayIndex(index)}
                    onFocus={() => setActiveDayIndex(index)}
                    onMouseEnter={() => setActiveDayIndex(index)}
                    tabIndex={0}
                    width={hitEnd - hitStart}
                    x={hitStart}
                    y={padding.top}
                  />
                )
              })}
              {visibleMetrics.map((metric) => {
                const points = days
                  .map((day, index) => {
                    const totals = getTrendTotals(day, selectedModel)
                    return `${xForIndex(index)},${yForValue(totals[metric.key])}`
                  })
                  .join(' ')
                return (
                  <g key={metric.key}>
                    <polyline
                      fill="none"
                      points={points}
                      stroke={metric.color}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2.25"
                    >
                      <title>{metric.label}</title>
                    </polyline>
                    {days.map((day, index) => {
                      const totals = getTrendTotals(day, selectedModel)
                      return (
                        <circle
                          key={`${day.date}-${metric.key}`}
                          cx={xForIndex(index)}
                          cy={yForValue(totals[metric.key])}
                          fill={metric.color}
                          onClick={() => setActiveDayIndex(index)}
                          onFocus={() => setActiveDayIndex(index)}
                          onMouseEnter={() => setActiveDayIndex(index)}
                          r="2.5"
                          tabIndex={0}
                        />
                      )
                    })}
                  </g>
                )
              })}
            </svg>
            <div className="mt-1 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setSelectedMetric(ALL_METRICS_VALUE)}
                className={`inline-flex items-center rounded-md border px-2 py-1 text-[13px] ${
                  selectedMetric === ALL_METRICS_VALUE ?
                    'border-line bg-sunken font-semibold text-ink'
                  : 'border-line bg-surface text-ink-soft'
                }`}
              >
                All
              </button>
              {metrics.map((metric) => (
                <button
                  key={metric.key}
                  type="button"
                  onClick={() => setSelectedMetric(metric.key)}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[13px] ${
                    selectedMetric === metric.key ?
                      'border-line bg-sunken font-semibold text-ink'
                    : 'border-line bg-surface text-ink-soft'
                  }`}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: metric.color }}
                  />
                  {metric.label}
                </button>
              ))}
            </div>
            {selectedDay && (
              <div className="mt-2 flex flex-wrap gap-2 rounded-md bg-sunken px-2.5 py-2 text-[13px] text-ink-soft">
                <span className="font-semibold text-ink">
                  {formatChartDate(selectedDay.date)}
                </span>
                {visibleMetrics.map((metric) => (
                  <span key={metric.key}>
                    {metric.label}:{' '}
                    {formatTokenCount(selectedDayTotals[metric.key])}
                  </span>
                ))}
              </div>
            )}
          </div>
        }
      </div>
    </div>
  )
}

function TokenUsageModelRow({ model }: { model: TokenUsageModelSummary }) {
  return (
    <tr className="border-b border-line-soft last:border-b-0">
      <td className="truncate px-2.5 py-1.5 text-ink" title={model.model}>
        {model.model}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatTokenCount(model.request_count)}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatTokenCount(model.input_tokens)}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatTokenCount(model.output_tokens)}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatTokenCount(model.cache_read_input_tokens)}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatTokenCount(model.cache_creation_input_tokens)}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatCacheHitRate(model)}
      </td>
      <td className="whitespace-nowrap px-2.5 py-1.5 text-right text-ink-soft">
        {formatLatency(model.average_first_token_ms)}
      </td>
      <td className="whitespace-nowrap px-2.5 py-1.5 text-right text-ink-soft">
        {formatOutputSpeed(model.output_tokens_per_second)}
      </td>
      <td className="px-2.5 py-1.5 text-right font-semibold text-ink">
        {formatTokenCount(calcTokenTotal(model))}
      </td>
      <td className="px-2.5 py-1.5 text-right font-semibold text-amber-700 dark:text-amber-400">
        <span className="inline-flex flex-col items-end leading-4">
          <TokenUsageValueLines value={formatTokenCosts(model.costs)} />
        </span>
      </td>
    </tr>
  )
}

function TokenUsageSessionRow({
  session,
}: {
  session: TokenUsageSessionSummary
}) {
  const sessionId = formatCellText(session.session_id)
  return (
    <tr className="border-b border-line-soft last:border-b-0">
      <td
        className="truncate px-2.5 py-1.5 font-mono text-ink"
        title={sessionId}
      >
        {sessionId}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatTokenCount(session.request_count)}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatTokenCount(session.input_tokens)}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatTokenCount(session.output_tokens)}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatTokenCount(session.cache_read_input_tokens)}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatTokenCount(session.cache_creation_input_tokens)}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatCacheHitRate(session)}
      </td>
      <td className="px-2.5 py-1.5 text-right font-semibold text-ink">
        {formatTokenCount(calcTokenTotal(session))}
      </td>
      <td className="px-2.5 py-1.5 text-right font-semibold text-amber-700 dark:text-amber-400">
        <span className="inline-flex flex-col items-end leading-4">
          <TokenUsageValueLines value={formatTokenCosts(session.costs)} />
        </span>
      </td>
    </tr>
  )
}

function TokenUsageEventRow({ event }: { event: TokenUsageEventRecord }) {
  return (
    <tr className="border-b border-line-soft last:border-b-0">
      <td
        className="whitespace-nowrap px-2.5 py-1.5 text-ink-soft"
        title={event.created_at_utc}
      >
        {formatEventTime(event.created_at_ms)}
      </td>
      <td
        className="max-w-[140px] truncate px-2.5 py-1.5 text-ink"
        title={formatCellText(event.user_id)}
      >
        {formatCellText(event.user_id)}
      </td>
      <td
        className="max-w-[180px] truncate px-2.5 py-1.5 text-ink"
        title={event.model}
      >
        {event.model}
      </td>
      <td
        className="max-w-[240px] truncate px-2.5 py-1.5 font-mono text-ink-soft"
        title={formatCellText(event.session_id)}
      >
        {formatCellText(event.session_id)}
      </td>
      <td
        className="max-w-[110px] truncate px-2.5 py-1.5 font-mono text-ink-soft"
        title={event.trace_id}
      >
        {event.trace_id}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatTokenCount(event.input_tokens)}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatTokenCount(event.output_tokens)}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatTokenCount(event.cache_read_input_tokens)}
      </td>
      <td className="px-2.5 py-1.5 text-right text-ink-soft">
        {formatTokenCount(event.cache_creation_input_tokens)}
      </td>
      <td className="whitespace-nowrap px-2.5 py-1.5 text-right text-ink-soft">
        {formatLatency(event.duration_ms)}
      </td>
      <td className="px-2.5 py-1.5 text-right font-semibold text-ink">
        {formatTokenCount(event.total_tokens)}
      </td>
      <td className="px-2.5 py-1.5 text-right font-semibold text-amber-700 dark:text-amber-400">
        <span className="inline-flex flex-col items-end leading-4">
          <TokenUsageValueLines value={formatTokenCost(event.cost)} />
        </span>
      </td>
    </tr>
  )
}
