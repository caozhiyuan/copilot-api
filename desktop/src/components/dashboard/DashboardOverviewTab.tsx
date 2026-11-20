import { getProviderTypeLabel } from '../../lib/provider-type-labels'
import {
  formatCacheHitRate,
  formatTokenCosts,
} from '../../lib/token-usage-format'
import type {
  ProviderManagementConfig,
  ServerAuthInfo,
  TokenUsageModelSummary,
  TokenUsagePeriod,
  TokenUsageSummary,
} from '../../types/ipc'
import ServerLogPanel from '../ServerLogPanel'
import { TokenUsageCostMetric, TokenUsageMetric } from '../TokenUsageMetric'

import {
  calcTokenTotal,
  EMPTY_TOKEN_USAGE_TOTALS,
  formatRefreshTime,
  formatTokenCount,
  getTokenUsagePeriodLabel,
  maskSecret,
  type DashboardModel,
  type DashboardTranslateFn,
} from './dashboard-format'
import { IconLaunch } from './DashboardIcons'

export function ServerStartForm({
  onPortChange,
  onStart,
  port,
  shouldShowFailureLogs,
  startError,
  starting,
  t,
}: {
  onPortChange: (value: string) => void
  onStart: () => void
  port: string
  shouldShowFailureLogs: boolean
  startError: string
  starting: boolean
  t: DashboardTranslateFn
}) {
  return (
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
            onChange={(e) => onPortChange(e.target.value)}
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
          onClick={onStart}
          disabled={starting}
          className="inline-flex w-full items-center justify-center gap-1.5 py-2 bg-accent-strong text-white text-[13px] font-semibold rounded-lg hover:bg-accent-strong/90 disabled:opacity-50 transition-colors"
        >
          <IconLaunch />
          {starting ? t('dashboard.starting') : t('dashboard.startServer')}
        </button>
      </div>
      {shouldShowFailureLogs && <ServerLogPanel variant="failure" />}
    </div>
  )
}

export function DashboardOverviewTab({
  anthropicUrl,
  copied,
  lastDashboardRefreshAt,
  loading,
  models,
  onCopy,
  onOpenProvidersTab,
  onOpenTokenUsageTab,
  openaiUrl,
  portNum,
  providerConfig,
  providerConfigSettled,
  restarting,
  serverAuthInfo,
  t,
  tokenUsage,
  tokenUsageLoading,
  tokenUsagePeriod,
  tokenUsageSettled,
}: {
  anthropicUrl: string
  copied: string
  lastDashboardRefreshAt: number | null
  loading: boolean
  models: DashboardModel[]
  onCopy: (text: string, key: string) => void
  onOpenProvidersTab: () => void
  onOpenTokenUsageTab: () => void
  openaiUrl: string
  portNum: number
  providerConfig: ProviderManagementConfig | null
  providerConfigSettled: boolean
  restarting: boolean
  serverAuthInfo: ServerAuthInfo
  t: DashboardTranslateFn
  tokenUsage: TokenUsageSummary | null
  tokenUsageLoading: boolean
  tokenUsagePeriod: TokenUsagePeriod
  tokenUsageSettled: boolean
}) {
  const providers = providerConfig?.providers ?? []
  const enabledProviderCount = providers.filter((item) => item.enabled).length
  const shouldShowProviderOverview =
    providerConfig !== null || !providerConfigSettled
  const showUsageSkeleton =
    !tokenUsage && (!tokenUsageSettled || tokenUsageLoading)
  const sortedProviders = [...providers].sort(
    (left, right) => Number(right.enabled) - Number(left.enabled),
  )
  const usageTotals = tokenUsage?.totals ?? EMPTY_TOKEN_USAGE_TOTALS
  const topUsageModel = tokenUsage?.byModel.reduce<
    TokenUsageModelSummary | undefined
  >(
    (top, model) =>
      top === undefined || model.request_count > top.request_count ?
        model
      : top,
    undefined,
  )
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

  return (
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
                item.tone === 'green' ? 'text-green-600 dark:text-green-400'
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
          {/* Usage snapshot */}
          <div className="shrink-0 bg-surface border border-line rounded-xl p-3">
            <div className="flex min-w-0 shrink-0 flex-nowrap items-center gap-x-2">
              <h3 className="text-[13px] font-semibold text-ink-faint uppercase tracking-wide">
                {t('dashboard.usageSnapshot')}
              </h3>
              {topUsageModel && (
                <div className="flex min-w-0 shrink items-baseline gap-1.5 overflow-hidden text-[12px] text-ink-faint">
                  <span className="shrink-0">
                    {t('dashboard.usageSnapshotTopModel')}
                  </span>
                  <span
                    className="max-w-[220px] truncate font-medium text-ink"
                    title={topUsageModel.model}
                  >
                    {topUsageModel.model}
                  </span>
                  <span className="shrink-0">
                    ·{' '}
                    {t('dashboard.usageSnapshotModelRequests', {
                      n: formatTokenCount(topUsageModel.request_count),
                    })}
                  </span>
                </div>
              )}
              <span className="ml-auto shrink-0 text-[12px] text-ink-faint">
                {getTokenUsagePeriodLabel(
                  t,
                  tokenUsage?.period ?? tokenUsagePeriod,
                )}
              </span>
              <button
                type="button"
                onClick={onOpenTokenUsageTab}
                className="shrink-0 text-[13px] text-accent transition-opacity hover:opacity-70"
              >
                {t('dashboard.tabTokenUsage')} →
              </button>
            </div>
            <div
              className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4"
              aria-label={
                showUsageSkeleton ? t('dashboard.loading') : undefined
              }
            >
              {showUsageSkeleton ?
                Array.from({ length: 4 }, (_, index) => (
                  <div
                    key={index}
                    className="animate-pulse rounded-lg border border-line bg-sunken px-2.5 py-2"
                  >
                    <div className="h-4" />
                    <div className="mt-1 h-4" />
                  </div>
                ))
              : tokenUsage ?
                <>
                  <TokenUsageMetric
                    label={t('dashboard.tokenUsageRequests')}
                    value={formatTokenCount(usageTotals.request_count)}
                    loading={false}
                    tone="violet"
                  />
                  <TokenUsageMetric
                    label={t('dashboard.tokenUsageTotalTokens')}
                    value={formatTokenCount(calcTokenTotal(usageTotals))}
                    loading={false}
                    tone="slate"
                  />
                  <TokenUsageMetric
                    label={t('dashboard.tokenUsageCacheHitRate')}
                    value={formatCacheHitRate(usageTotals)}
                    loading={false}
                    tone="blue"
                  />
                  <TokenUsageCostMetric
                    label={t('dashboard.tokenUsageCost')}
                    value={formatTokenCosts(usageTotals.costs).join(' ')}
                    loading={false}
                  />
                </>
              : <div className="col-span-2 px-2.5 py-2 text-[13px] text-ink-faint sm:col-span-4">
                  <div className="flex h-4 items-center">
                    {t('dashboard.noTokenUsage')}
                  </div>
                  <div className="mt-1 h-4" />
                </div>
              }
            </div>
          </div>

          {/* Provider overview */}
          {shouldShowProviderOverview && (
            <div className="shrink-0 bg-surface border border-line rounded-xl p-3">
              <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
                <h3 className="text-[13px] font-semibold text-ink-faint uppercase tracking-wide">
                  {t('dashboard.providerOverview')}
                </h3>
                <div className="flex shrink-0 items-center gap-2 text-[13px]">
                  {providerConfig !== null && (
                    <span className="text-ink-faint">
                      {t('dashboard.providerOverviewSummary', {
                        enabled: enabledProviderCount,
                        total: providers.length,
                      })}
                    </span>
                  )}
                  <button
                    onClick={onOpenProvidersTab}
                    className="text-accent transition-opacity hover:opacity-70"
                  >
                    {t('dashboard.providerOverviewManage')}
                  </button>
                </div>
              </div>
              <div
                className="h-[140px] space-y-1 overflow-y-auto"
                aria-label={
                  providerConfig === null ? t('dashboard.loading') : undefined
                }
              >
                {providerConfig === null ?
                  Array.from({ length: 3 }, (_, index) => (
                    <div
                      key={index}
                      className="h-8 animate-pulse rounded-lg bg-sunken"
                    />
                  ))
                : sortedProviders.map((provider) => (
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
                      {(provider.agentsModels?.length || !provider.enabled) && (
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
                  ))
                }
              </div>
            </div>
          )}

          {/* Service endpoints */}
          <div className="shrink-0 bg-surface border border-line rounded-xl px-2.5 py-[15px]">
            <h3 className="text-[13px] font-semibold text-ink-faint uppercase tracking-wide mb-1.5">
              {t('dashboard.serviceAddress')}
            </h3>
            <div className="space-y-1">
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
                  className="flex items-center gap-2 px-2.5 py-1 bg-sunken rounded-lg"
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
                    onClick={() => onCopy(url, key)}
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
                <div className="mt-2 pt-2 border-t border-line-soft">
                  <h4 className="text-[13px] font-semibold text-ink-faint uppercase tracking-wide mb-1">
                    {t('dashboard.authHeader')}
                  </h4>
                  <div className="flex items-start gap-2 px-2.5 py-1 bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30 rounded-lg">
                    <span className="text-[13px] font-mono text-amber-900 dark:text-amber-400 break-all flex-1">
                      {maskedServerAuthHeader}
                    </span>
                    <button
                      onClick={() => onCopy(serverAuthHeader, 'auth-header')}
                      className="shrink-0 text-[13px] text-accent hover:text-accent"
                    >
                      {copied === 'auth-header' ? '✓' : t('dashboard.copy')}
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
  )
}
