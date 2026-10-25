import { useEffect, useState } from 'react'

import { useLanguage } from '../contexts/LanguageContext'
import type { SubscriptionProvider, SubscriptionUsage } from '../types/ipc'
import type { SubscriptionQuotaWindow } from '../../../src/lib/types/subscription-usage'

type TranslateFn = ReturnType<typeof useLanguage>['t']

function quotaLabel(window: SubscriptionQuotaWindow, t: TranslateFn): string {
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
  unit: 'credits' | 'USD' | undefined,
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
    <div className="space-y-3">
      {usage.limitReached && (
        <p className="text-[13px] text-amber-600 dark:text-amber-400">
          {limitMessage}
        </p>
      )}
      {usage.windows.map((window) => {
        const percent = window.usedPercent
        const reset =
          window.resetAt === undefined ? null : new Date(window.resetAt * 1000)
        return (
          <div key={window.id} className="space-y-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-[13px]">
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
                {percent === undefined ?
                  '—'
                : t('dashboard.quotaUsedPercent', {
                    percent: Math.round(percent * 10) / 10,
                  })
                }
              </span>
            </div>
            {percent !== undefined && (
              <div
                role="progressbar"
                aria-label={quotaLabel(window, t)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.min(100, Math.max(0, percent))}
                className="h-1.5 overflow-hidden rounded-full bg-sunken"
              >
                <div
                  className={`h-full rounded-full ${percent >= 90 || window.limitReached ? 'bg-amber-500' : 'bg-accent'}`}
                  style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                />
              </div>
            )}
            {(window.used !== undefined || window.limit !== undefined) && (
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
                : ''}
              </p>
            )}
            {reset && Number.isFinite(reset.getTime()) && (
              <p className="text-[12px] text-ink-faint">
                {t('dashboard.quotaResetsOn', { date: reset.toLocaleString() })}
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

  return (
    <section
      className="shrink-0 rounded-xl border border-line bg-surface p-3"
      aria-label={`${provider === 'codex' ? 'Codex' : 'xAI'} ${t('dashboard.subscriptionQuota')}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-ink-faint">
          {provider === 'codex' ? 'Codex' : 'xAI'} ·{' '}
          {t('dashboard.subscriptionQuota')}
        </h3>
        <div className="flex min-w-0 items-center gap-2">
          {usage?.planType && (
            <span className="truncate text-[12px] text-ink-soft">
              {usage.planType}
            </span>
          )}
          <button
            className="shrink-0 text-[13px] text-accent disabled:opacity-50"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            {t('dashboard.refresh')}
          </button>
        </div>
      </div>
      {loading ?
        <p className="animate-pulse text-[13px] text-ink-faint">
          {t('dashboard.loading')}
        </p>
      : failed ?
        <p
          role="alert"
          className="text-[13px] text-amber-600 dark:text-amber-400"
        >
          {t('dashboard.quotaLoadFailed')}
        </p>
      : usage ?
        <SubscriptionQuotaDetails usage={usage} />
      : <p className="text-[13px] text-ink-faint">
          {t('dashboard.quotaAccountUnavailable')}
        </p>
      }
    </section>
  )
}
