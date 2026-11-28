import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

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
import Header from '../components/Header'
import ServerLogPanel from '../components/ServerLogPanel'
import { PageLoadingSkeleton } from '../components/ui/LoadingState'
import { useLanguage } from '../contexts/LanguageContext'
import { useServerLifecycle } from '../hooks/useServerLifecycle'
import { useTokenUsage } from '../hooks/useTokenUsage'
import type {
  DesktopAuthMode,
  ProviderManagementConfig,
  ServerStatus,
} from '../types/ipc'

const ApiKeyManager = lazy(() => import('../components/ApiKeyManager'))
const TokenUsagePanel = lazy(() =>
  import('../components/dashboard/TokenUsagePanel').then((mod) => ({
    default: mod.TokenUsagePanel,
  })),
)
const ProviderManagementPanel = lazy(
  () => import('../components/ProviderManagementPanel'),
)
const AdvancedConfigPage = lazy(() => import('./AdvancedConfigPage'))
const ClientIntegrationsPage = lazy(() => import('./ClientIntegrationsPage'))
const MediaStudioPage = lazy(() => import('./MediaStudioPage'))
const SubscriptionsPage = lazy(() => import('./SubscriptionsPage'))

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

export default function DashboardPage({
  defaultPort,
  defaultHost,
  initialServerStatus,
  initialTab = 'dashboard',
  onChangeAuth,
}: DashboardPageProps) {
  const { t } = useLanguage()
  const [tab, setTab] = useState<DashboardTab>(initialTab)
  const [advancedConfigOpened, setAdvancedConfigOpened] = useState(false)
  const [studioOpened, setStudioOpened] = useState(false)
  const [subscriptionsOpened, setSubscriptionsOpened] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [quotaRefreshKey, setQuotaRefreshKey] = useState(0)
  const [models, setModels] = useState<DashboardModel[]>([])
  const [providerConfig, setProviderConfig] =
    useState<ProviderManagementConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastDashboardRefreshAt, setLastDashboardRefreshAt] = useState<
    number | null
  >(null)
  const [providerConfigSettled, setProviderConfigSettled] = useState(false)
  const [copied, setCopied] = useState<string>('')
  const copyFeedbackTimer = useRef<ReturnType<typeof setTimeout>>()
  const resetTokenUsageRef = useRef(() => {})

  const server = useServerLifecycle({
    defaultHost,
    defaultPort,
    initialServerStatus,
    onServerStopped: () => {
      resetTokenUsageRef.current()
      setModels([])
      setLastDashboardRefreshAt(null)
    },
    t,
  })

  const usage = useTokenUsage({
    isTokenUsageTab: tab === 'tokenUsage',
    serverActive: server.started && !server.restarting,
  })
  resetTokenUsageRef.current = usage.resetTokenUsageState

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

  useEffect(() => {
    if (!server.started && !TABS_REACHABLE_WHILE_STOPPED.includes(tab)) {
      setTab('dashboard')
    }
  }, [server.started, tab])

  useEffect(
    () => () => {
      if (copyFeedbackTimer.current) {
        clearTimeout(copyFeedbackTimer.current)
      }
    },
    [],
  )

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

  const refreshOnServerStartRef = useRef(() => {})
  refreshOnServerStartRef.current = () => {
    void fetchData()
    void usage.fetchTokenUsageData(
      usage.tokenUsagePeriod,
      usage.tokenUsageEventsPage,
    )
  }

  // Fetch dashboard and token usage data after the server starts.
  useEffect(() => {
    if (server.started && !server.restarting) {
      refreshOnServerStartRef.current()
    }
  }, [server.started, server.restarting])

  // The provider list can change on the Providers tab, so read it again
  // whenever the dashboard is shown.
  useEffect(() => {
    if (server.started && !server.restarting && tab === 'dashboard') {
      void fetchProviderConfig()
    }
  }, [server.started, server.restarting, tab])

  const handleChangeAuth = () => {
    onChangeAuth(tab === 'providers' ? 'providers' : 'dashboard')
  }

  // The listening host is configured in the settings modal, so reload the
  // saved value once the modal closes.
  const handleSettingsClose = () => {
    void window.electronAPI
      .getSettings()
      .then((saved) => {
        if (saved.host !== undefined) server.setHost(saved.host)
        setShowCreate(saved.showCreate === true)
      })
      .catch(() => {})
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
      void usage.fetchTokenUsageData()
    }
  }

  const handleCopy = (text: string, key: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        if (copyFeedbackTimer.current) {
          clearTimeout(copyFeedbackTimer.current)
        }
        setCopied(key)
        copyFeedbackTimer.current = setTimeout(() => {
          copyFeedbackTimer.current = undefined
          setCopied('')
        }, 1500)
      })
      .catch(() => {})
  }

  const isActiveTabRefreshing =
    tab === 'dashboard' ? loading
    : tab === 'tokenUsage' ? usage.isRefreshing
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
    server.started
    && (tab === 'dashboard' || tab === 'tokenUsage' || tab === 'subscriptions')
  const showStartForm =
    !server.started && !TABS_WITHOUT_START_FORM.includes(tab)
  const isServerRunning = server.started && !server.stopping
  const isServerReady = isServerRunning && !server.restarting

  return (
    <div className="flex flex-col h-screen bg-canvas">
      <Header
        onChangeAuth={handleChangeAuth}
        onRestart={server.handleRestart}
        onStop={server.handleStop}
        onSettingsClose={handleSettingsClose}
        isRunning={isServerRunning}
        isRestarting={server.restarting}
      />

      {/* Unexpected server stop banner */}
      {server.serverError && (
        <div className="mx-4 mt-2 px-3 py-2 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg text-[13px] text-red-600 dark:text-red-400 flex items-center gap-1.5 shrink-0">
          <span>⚠️</span>
          <span>{server.serverError}</span>
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
                !server.started
                && !TABS_REACHABLE_WHILE_STOPPED.includes(tabItem.key)
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
            disabled={isActiveTabRefreshing || server.restarting}
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
              server.setPort(value)
              server.setStartError('')
            }}
            onStart={() => void server.handleStart()}
            port={server.port}
            shouldShowFailureLogs={server.shouldShowFailureLogs}
            startError={server.startError}
            starting={server.starting}
            t={t}
          />
        )}

        {/* Dashboard tab */}
        {server.started && tab === 'dashboard' && (
          <DashboardOverviewTab
            anthropicUrl={server.anthropicUrl}
            copied={copied}
            lastDashboardRefreshAt={lastDashboardRefreshAt}
            loading={loading}
            models={models}
            onCopy={handleCopy}
            onOpenProvidersTab={() => setTab('providers')}
            onOpenTokenUsageTab={() => setTab('tokenUsage')}
            openaiUrl={server.openaiUrl}
            portNum={server.portNum}
            providerConfig={providerConfig}
            providerConfigSettled={providerConfigSettled}
            restarting={server.restarting}
            serverAuthInfo={server.serverAuthInfo}
            t={t}
            tokenUsage={usage.tokenUsage}
            tokenUsageLoading={usage.tokenUsageLoading}
            tokenUsagePeriod={usage.tokenUsagePeriod}
            tokenUsageSettled={usage.tokenUsageSettled}
          />
        )}

        <Suspense
          fallback={
            <PageLoadingSkeleton
              delayed
              data-tab-loading="true"
              label={t('dashboard.loading')}
            />
          }
        >
          {(subscriptionsOpened
            || (server.started && tab === 'subscriptions')) && (
            <div
              className={
                server.started && tab === 'subscriptions' ? 'h-full' : 'hidden'
              }
            >
              <SubscriptionsPage
                refreshKey={quotaRefreshKey}
                onManageProviders={() => setTab('providers')}
              />
            </div>
          )}

          {/* Token usage tab */}
          {server.started && tab === 'tokenUsage' && (
            <div className="p-4">
              <TokenUsagePanel
                keyFilterControl={
                  <label className="flex items-center gap-2 text-[13px] text-ink-soft">
                    {t('apiKeys.keyFilter')}
                    <select
                      aria-label={t('apiKeys.keyFilter')}
                      className="rounded-md border border-line bg-surface px-2 py-1 text-ink"
                      value={usage.apiKeyFilter}
                      onChange={(event) =>
                        usage.handleApiKeyFilterChange(event.target.value)
                      }
                    >
                      <option value="">{t('apiKeys.allKeys')}</option>
                      <option value="__unattributed__">
                        {t('apiKeys.unattributed')}
                      </option>
                      {usage.managedApiKeys.map((key, index) => (
                        <option key={key.id} value={key.id}>
                          {key.name ?? t('clients.keyNumber', { n: index + 1 })}
                        </option>
                      ))}
                    </select>
                  </label>
                }
                dailyUsage={usage.tokenUsageDaily}
                eventsPage={usage.tokenUsageEvents}
                eventsLoading={usage.tokenUsageEventsLoading}
                loading={usage.tokenUsageLoading}
                onEventsPageChange={usage.handleTokenUsageEventsPageChange}
                onSessionsPageChange={usage.handleTokenUsageSessionsPageChange}
                period={usage.tokenUsagePeriod}
                sessionsError={usage.tokenUsageSessionsError}
                sessionsLoading={usage.tokenUsageSessionsLoading}
                sessionsPage={usage.tokenUsageSessions}
                tokenUsage={usage.tokenUsage}
                onPeriodChange={usage.handleTokenUsagePeriodChange}
                t={t}
              />
            </div>
          )}

          {tab === 'providers' && (
            <ProviderManagementPanel
              serverRunning={isServerRunning}
              onOpenAuthConfig={handleChangeAuth}
            />
          )}

          {tab === 'clients' && (
            <ClientIntegrationsPage
              initialBaseUrl={server.anthropicUrl}
              serverRunning={isServerReady}
            />
          )}

          {tab === 'apiKeys' && <ApiKeyManager />}

          {showCreate && (tab === 'studio' || studioOpened) && (
            <div className={tab === 'studio' ? 'h-full' : 'hidden'}>
              <MediaStudioPage serverRunning={isServerReady} />
            </div>
          )}

          {/* Keep the editor mounted after opening it to preserve unsaved drafts. */}
          {(tab === 'advancedConfig' || advancedConfigOpened) && (
            <div className={tab === 'advancedConfig' ? 'h-full' : 'hidden'}>
              <AdvancedConfigPage
                active={tab === 'advancedConfig'}
                serverRunning={isServerReady}
              />
            </div>
          )}
        </Suspense>

        {/* Keep the panel mounted so startup lines stream in during a restart. */}
        {server.started && tab === 'logs' && (
          <ServerLogPanel key={server.logPanelSession} variant="page" />
        )}
      </div>
    </div>
  )
}
