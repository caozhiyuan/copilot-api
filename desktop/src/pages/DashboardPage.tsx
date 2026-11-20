import { useEffect, useRef, useState, type ReactNode } from 'react'

import ApiKeyManager from '../components/ApiKeyManager'
import type { DashboardModel } from '../components/dashboard/dashboard-format'
import {
  IconAdvancedConfig,
  IconApiKeys,
  IconClients,
  IconDashboard,
  IconLaunch,
  IconLogs,
  IconProviders,
  IconRefresh,
  IconSubscriptions,
  IconTokenUsage,
} from '../components/dashboard/DashboardIcons'
import {
  DashboardOverviewTab,
  ServerStartForm,
} from '../components/dashboard/DashboardOverviewTab'
import { TokenUsagePanel } from '../components/dashboard/TokenUsagePanel'
import Header from '../components/Header'
import ProviderManagementPanel from '../components/ProviderManagementPanel'
import ServerLogPanel from '../components/ServerLogPanel'
import { useLanguage } from '../contexts/LanguageContext'
import { buildServerBaseUrl } from '../lib/server-url'
import type {
  DesktopAuthMode,
  GatewayApiKeyConfig,
  ProviderManagementConfig,
  ServerAuthInfo,
  ServerStatus,
  TokenUsageDailySummary,
  TokenUsageEventsPage,
  TokenUsagePeriod,
  TokenUsageSessionsPage,
  TokenUsageSummary,
} from '../types/ipc'
import AdvancedConfigPage from './AdvancedConfigPage'
import ClientIntegrationsPage from './ClientIntegrationsPage'
import MediaStudioPage from './MediaStudioPage'
import SubscriptionsPage from './SubscriptionsPage'

interface DashboardPageProps {
  authMode: DesktopAuthMode
  defaultPort: number
  defaultHost: string
  initialServerStatus?: ServerStatus
  initialTab?: 'dashboard' | 'providers'
  onChangeAuth: (returnTab: 'dashboard' | 'providers') => void
}

type DashboardTab =
  | 'dashboard'
  | 'tokenUsage'
  | 'subscriptions'
  | 'providers'
  | 'apiKeys'
  | 'clients'
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
  'apiKeys',
  'clients',
  'advancedConfig',
  'studio',
]
const TABS_REACHABLE_WHILE_STOPPED: ReadonlyArray<DashboardTab> = [
  'dashboard',
  ...TABS_WITHOUT_START_FORM,
]

const TOKEN_USAGE_EVENTS_PAGE_SIZE = 10
const TOKEN_USAGE_SESSIONS_PAGE_SIZE = 5

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
  const [logPanelSession, setLogPanelSession] = useState(0)

  const [tab, setTab] = useState<DashboardTab>(initialTab)
  const [advancedConfigOpened, setAdvancedConfigOpened] = useState(false)
  const [studioOpened, setStudioOpened] = useState(false)
  const [subscriptionsOpened, setSubscriptionsOpened] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  useEffect(() => {
    if (tab === 'advancedConfig') setAdvancedConfigOpened(true)
    if (tab === 'studio') setStudioOpened(true)
    if (tab === 'subscriptions') setSubscriptionsOpened(true)
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
  const [apiKeyFilter, setApiKeyFilter] = useState('')
  const apiKeyFilterRef = useRef('')
  const [managedApiKeys, setManagedApiKeys] = useState<GatewayApiKeyConfig[]>(
    [],
  )
  const [models, setModels] = useState<DashboardModel[]>([])
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
  const [tokenUsageSettled, setTokenUsageSettled] = useState(false)
  const [providerConfigSettled, setProviderConfigSettled] = useState(false)
  const [tokenUsageEventsLoading, setTokenUsageEventsLoading] = useState(false)
  const [tokenUsageSessionsLoading, setTokenUsageSessionsLoading] =
    useState(false)
  const [tokenUsageSessionsError, setTokenUsageSessionsError] = useState(false)
  const [serverError, setServerError] = useState('')
  const [copied, setCopied] = useState<string>('')

  const intentionalStop = useRef(false)
  const wasRestarting = useRef(false)
  // Keep the live log subscription open while restarting, then load the new
  // process's history when the restart finishes.
  useEffect(() => {
    if (wasRestarting.current && !restarting) {
      setLogPanelSession((session) => session + 1)
    }
    wasRestarting.current = restarting
  }, [restarting])
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
        }
        intentionalStop.current = false
      }
    })
    return unsubscribe
  }, [])

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

  const resetStoppedState = () => {
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
    setModels([])
    setLastDashboardRefreshAt(null)
  }

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
      }
    } catch (err) {
      setStartError((err as Error).message)
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
    resetStoppedState()
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
        resetStoppedState()
        setStartError(status.error ?? t('dashboard.serverUnexpectedStop'))
      }
    } catch (err) {
      setStarted(false)
      setStartError((err as Error).message)
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
        const d = modelsData as { data: DashboardModel[] }
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
    } finally {
      setProviderConfigSettled(true)
    }
  }

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

  useEffect(() => {
    if (tab !== 'tokenUsage') return
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
  }, [tab])

  const handleApiKeyFilterChange = (value: string) => {
    apiKeyFilterRef.current = value
    setApiKeyFilter(value)
    setTokenUsageEventsPage(1)
    setTokenUsageSessionsPage(1)
    setTokenUsage(null)
    setTokenUsageDaily(null)
    setTokenUsageEvents(null)
    setTokenUsageSessions(null)
    if (started && !restarting) void fetchTokenUsageData(tokenUsagePeriod, 1, 1)
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
    }
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

  const shouldShowFailureLogs = !started && Boolean(startError || serverError)
  const isActiveTabRefreshing =
    tab === 'dashboard' ? loading
    : tab === 'tokenUsage' ?
      tokenUsageLoading || tokenUsageEventsLoading || tokenUsageSessionsLoading
    : false

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
      icon: <IconSubscriptions />,
      key: 'subscriptions',
      label: t('dashboard.tabSubscriptions'),
    },
    {
      icon: <IconProviders />,
      key: 'providers',
      label: t('providers.title'),
    },
    { icon: <IconApiKeys />, key: 'apiKeys', label: t('apiKeys.title') },
    { icon: <IconClients />, key: 'clients', label: t('clients.title') },
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
          <ServerStartForm
            onPortChange={(value) => {
              setPort(value)
              setStartError('')
            }}
            onStart={() => void handleStart()}
            port={port}
            shouldShowFailureLogs={shouldShowFailureLogs}
            startError={startError}
            starting={starting}
            t={t}
          />
        )}

        {/* Dashboard tab */}
        {started && tab === 'dashboard' && (
          <DashboardOverviewTab
            anthropicUrl={anthropicUrl}
            copied={copied}
            lastDashboardRefreshAt={lastDashboardRefreshAt}
            loading={loading}
            models={models}
            onCopy={handleCopy}
            onOpenProvidersTab={() => setTab('providers')}
            onOpenTokenUsageTab={() => setTab('tokenUsage')}
            openaiUrl={openaiUrl}
            portNum={portNum}
            providerConfig={providerConfig}
            providerConfigSettled={providerConfigSettled}
            restarting={restarting}
            serverAuthInfo={serverAuthInfo}
            t={t}
            tokenUsage={tokenUsage}
            tokenUsageLoading={tokenUsageLoading}
            tokenUsagePeriod={tokenUsagePeriod}
            tokenUsageSettled={tokenUsageSettled}
          />
        )}

        {(subscriptionsOpened || (started && tab === 'subscriptions')) && (
          <div
            className={started && tab === 'subscriptions' ? 'h-full' : 'hidden'}
          >
            <SubscriptionsPage
              refreshKey={quotaRefreshKey}
              onManageProviders={() => setTab('providers')}
            />
          </div>
        )}

        {/* Token usage tab */}
        {started && tab === 'tokenUsage' && (
          <div className="p-4">
            <TokenUsagePanel
              keyFilterControl={
                <label className="flex items-center gap-2 text-[13px] text-ink-soft">
                  {t('apiKeys.keyFilter')}
                  <select
                    aria-label={t('apiKeys.keyFilter')}
                    className="rounded-md border border-line bg-surface px-2 py-1 text-ink"
                    value={apiKeyFilter}
                    onChange={(event) =>
                      handleApiKeyFilterChange(event.target.value)
                    }
                  >
                    <option value="">{t('apiKeys.allKeys')}</option>
                    <option value="__unattributed__">
                      {t('apiKeys.unattributed')}
                    </option>
                    {managedApiKeys.map((key, index) => (
                      <option key={key.id} value={key.id}>
                        {key.name ?? t('clients.keyNumber', { n: index + 1 })}
                      </option>
                    ))}
                  </select>
                </label>
              }
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

        {tab === 'clients' && (
          <ClientIntegrationsPage
            initialBaseUrl={anthropicUrl}
            serverRunning={started && !stopping && !restarting}
          />
        )}

        {tab === 'apiKeys' && <ApiKeyManager />}

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

        {/* Keep the panel mounted so startup lines stream in during a restart. */}
        {started && tab === 'logs' && (
          <ServerLogPanel key={logPanelSession} variant="page" />
        )}
      </div>
    </div>
  )
}
