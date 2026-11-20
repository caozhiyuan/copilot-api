import { useState, type ReactNode } from 'react'

import type {
  TokenUsageDailySummary,
  TokenUsageEventsPage,
  TokenUsagePeriod,
  TokenUsageSessionsPage,
  TokenUsageSummary,
} from '../../types/ipc'

import {
  ALL_MODELS_VALUE,
  EMPTY_TOKEN_USAGE_TOTALS,
  getTokenUsagePeriodLabel,
  TOKEN_USAGE_PERIODS,
  type DashboardTranslateFn,
} from './dashboard-format'
import {
  TokenUsageEventRow,
  TokenUsageModelRow,
  TokenUsageSessionRow,
} from './TokenUsageRows'
import { TokenUsageSummaryMetrics } from './TokenUsageSummaryMetrics'
import { TokenUsageTrendChart } from './TokenUsageTrendChart'

export function TokenUsagePanel({
  keyFilterControl,
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
  keyFilterControl?: ReactNode
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
  t: DashboardTranslateFn
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
          {keyFilterControl}
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
