import {
  formatCacheHitRate,
  formatTokenCost,
  formatTokenCosts,
} from '../../lib/token-usage-format'
import type { TokenUsageTotals } from '../../types/ipc'
import { TokenUsageCostMetric, TokenUsageMetric } from '../TokenUsageMetric'

import {
  calcTokenTotal,
  formatTokenCount,
  type DashboardTranslateFn,
} from './dashboard-format'

export function TokenUsageSummaryMetrics({
  className,
  loading,
  t,
  totals,
}: {
  className: string
  loading: boolean
  t: DashboardTranslateFn
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
