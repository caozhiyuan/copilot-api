import { useEffect, useState } from 'react'

import { useLanguage } from '../contexts/LanguageContext'
import { subscriptionProviders } from '../lib/subscription-providers'
import type { SubscriptionProvider, SubscriptionUsage } from '../types/ipc'
import type { SubscriptionQuotaWindow } from '../../../src/lib/types/subscription-usage'

type TranslateFn = ReturnType<typeof useLanguage>['t']

function quotaLabel(window: SubscriptionQuotaWindow, t: TranslateFn): string {
  if (window.id.startsWith('copilot:')) return window.name ?? 'Premium'
  if (window.kind === 'spend') return t('dashboard.quotaMonthlyCredits')
  if (window.kind === 'on-demand') return t('dashboard.quotaOnDemand')
  const seconds = window.windowSeconds
  const period =
    window.period === 'weekly' || seconds === 604800 ?
      t('dashboard.quotaWeekly')
    : window.period === 'monthly' ? t('dashboard.quotaMonthly')
    : seconds && seconds >= 86400 ?
      t('dashboard.quotaDays', { n: seconds / 86400 })
    : seconds && seconds >= 3600 ?
      t('dashboard.quotaHours', { n: seconds / 3600 })
    : seconds ? t('dashboard.quotaMinutes', { n: seconds / 60 })
    : t('dashboard.quotaAllowance')
  return window.name ? `${window.name} · ${period}` : period
}

function formatAmount(
  value: number,
  unit?: SubscriptionQuotaWindow['unit'],
): string {
  return unit === 'USD' ?
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
      }).format(value)
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
        value,
      )
}

export function SubscriptionQuotaSummary({
  usage,
}: {
  usage: SubscriptionUsage
}) {
  const { t } = useLanguage()
  const main =
    usage.windows.find((window) => window.kind === 'usage') ?? usage.windows[0]
  const credits = usage.credits
  const showCredits =
    credits && (credits.hasCredits || credits.unlimited || !main)
  const value =
    showCredits ?
      credits.unlimited ? '∞'
      : credits.balance === undefined ? '—'
      : formatAmount(credits.balance, credits.unit)
    : main?.unlimited ? '∞'
    : main?.usedPercent === undefined ? '—'
    : `${formatAmount(Math.max(0, Math.min(100, 100 - main.usedPercent)))}%`
  return (
    <div className="quota-summary">
      <p className="quota-summary-label">
        {showCredits ?
          t(
            credits.unit === 'USD' ?
              'dashboard.quotaPrepaid'
            : 'dashboard.quotaCredits',
          )
        : t('dashboard.quotaRemaining')}
      </p>
      <div className="quota-summary-value">{value}</div>
      <p className="quota-summary-context">
        {showCredits ?
          credits.unlimited ?
            t('dashboard.quotaUnlimited')
          : t('dashboard.quotaAvailableBalance')
        : main ?
          quotaLabel(main, t)
        : t('dashboard.quotaAllowance')}
      </p>
    </div>
  )
}

export function SubscriptionQuotaDetails({
  usage,
}: {
  usage: SubscriptionUsage
}) {
  const { t } = useLanguage()
  const credits = usage.credits
  const reason = usage.limitReason
  const limitMessage =
    (
      reason === 'workspace_owner_credits_depleted'
      || reason === 'workspace_member_credits_depleted'
    ) ?
      t('dashboard.quotaWorkspaceCreditsDepleted')
    : (
      reason === 'workspace_owner_usage_limit_reached'
      || reason === 'workspace_member_usage_limit_reached'
    ) ?
      t('dashboard.quotaWorkspaceLimitReached')
    : t('dashboard.quotaLimitReached')
  return (
    <div className="quota-details space-y-4">
      {usage.limitReached && (
        <p className="text-[13px] text-amber-600 dark:text-amber-400">
          {limitMessage}
        </p>
      )}
      {usage.windows.map((window) => {
        const percent = window.usedPercent
        const reset =
          window.resetAt === undefined ? null : new Date(window.resetAt * 1000)
        const resetDate =
          window.resetDate
          ?? (reset && Number.isFinite(reset.getTime()) ?
            reset.toLocaleString()
          : null)
        return (
          <div
            key={window.id}
            className="quota-window space-y-1.5"
            data-warning={Boolean(window.limitReached || (percent ?? 0) >= 90)}
          >
            <div className="quota-window-heading flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-[13px]">
              <span className="font-medium text-ink-soft">
                {quotaLabel(window, t)}
              </span>
              <span
                className={
                  window.limitReached ?
                    'text-amber-600 dark:text-amber-400'
                  : 'text-ink-faint'
                }
              >
                {window.unlimited ?
                  t('dashboard.quotaUnlimited')
                : percent === undefined ?
                  '—'
                : t('dashboard.quotaUsedPercent', {
                    percent: Math.round(percent * 10) / 10,
                  })
                }
              </span>
            </div>
            {percent !== undefined && !window.unlimited && (
              <div
                role="progressbar"
                aria-label={quotaLabel(window, t)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.min(100, Math.max(0, percent))}
                className="quota-progress"
              >
                <div
                  className="quota-progress-fill"
                  style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                />
              </div>
            )}
            {!window.unlimited
              && (window.used !== undefined || window.limit !== undefined) && (
                <p className="text-[12px] text-ink-faint">
                  {window.used === undefined ?
                    '—'
                  : formatAmount(window.used, window.unit)}{' '}
                  /{' '}
                  {window.limit === undefined ?
                    '—'
                  : formatAmount(window.limit, window.unit)}
                  {window.unit === 'credits' ?
                    ` ${t('dashboard.quotaCredits')}`
                  : window.unit === 'requests' ?
                    ` ${t('dashboard.quotaRequests')}`
                  : ''}
                </p>
              )}
            {resetDate && (
              <p className="text-[12px] text-ink-faint">
                {t('dashboard.quotaResetsOn', { date: resetDate })}
              </p>
            )}
          </div>
        )
      })}
      {credits && (
        <div className="flex items-baseline justify-between gap-2 text-[13px]">
          <span className="text-ink-soft">
            {t(
              credits.unit === 'USD' ?
                'dashboard.quotaPrepaid'
              : 'dashboard.quotaCredits',
            )}
          </span>
          <span className="font-medium text-ink">
            {credits.unlimited ?
              t('dashboard.quotaUnlimited')
            : credits.balance !== undefined ?
              formatAmount(credits.balance, credits.unit)
            : credits.hasCredits ?
              t('dashboard.quotaCreditsAvailable')
            : '—'}
          </span>
        </div>
      )}
      {usage.windows.length === 0 && !credits && !usage.limitReached && (
        <p className="text-[13px] text-ink-faint">
          {t('dashboard.quotaUnavailable')}
        </p>
      )}
    </div>
  )
}

export default function SubscriptionQuotaCard({
  provider,
  refreshKey,
}: {
  provider: SubscriptionProvider
  refreshKey: unknown
}) {
  const { t } = useLanguage()
  const [usage, setUsage] = useState<SubscriptionUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setFailed(false)
    setUsage(null)
    void window.electronAPI
      .fetchSubscriptionUsage(provider)
      .then((result) => {
        if (active) setUsage(result)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [provider, refreshKey, revision])

  const meta = subscriptionProviders[provider]
  const status =
    loading ? t('dashboard.loading')
    : failed ? t('dashboard.quotaLoadFailedShort')
    : usage?.limitReached ? t('dashboard.quotaLimitReachedShort')
    : usage ? t('dashboard.quotaConnected')
    : t('dashboard.quotaNotConnected')
  return (
    <section
      className="quota-provider-card"
      data-provider={provider}
      aria-label={`${meta.name} ${t('dashboard.subscriptionQuota')}`}
    >
      <div className="quota-card-header">
        <span className="quota-provider-logo">
          <img src={meta.logo} alt="" className="dark:invert" />
        </span>
        <div className="min-w-0 flex-1">
          <h3>{meta.name}</h3>
          <p className="quota-provider-product">{meta.product}</p>
        </div>
        <button
          className="quota-refresh"
          title={t('dashboard.refresh')}
          aria-label={t('dashboard.quotaRefreshProvider', {
            provider: meta.name,
          })}
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <svg
            className={loading ? 'animate-spin' : undefined}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 7v5h-5M4 17v-5h5" />
            <path d="M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 18 17" />
          </svg>
        </button>
      </div>
      <div className="quota-card-meta">
        <span className="quota-plan">{usage?.planType || meta.product}</span>
        <span
          className="quota-status"
          data-state={
            loading ? 'loading'
            : failed || usage?.limitReached ?
              'warning'
            : usage ?
              'ready'
            : 'unavailable'
          }
        >
          <span />
          {status}
        </span>
      </div>
      {loading ?
        <div className="quota-skeleton" aria-label={t('dashboard.loading')}>
          <div />
          <div />
          <div />
        </div>
      : failed ?
        <p role="alert" className="quota-card-message">
          {t('dashboard.quotaLoadFailed')}
        </p>
      : usage ?
        <>
          <SubscriptionQuotaSummary usage={usage} />
          <SubscriptionQuotaDetails usage={usage} />
        </>
      : <p className="quota-card-message">
          {t('dashboard.quotaAccountUnavailable')}
        </p>
      }
      <div className="quota-card-footer">{t('dashboard.quotaLiveUsage')}</div>
    </section>
  )
}
