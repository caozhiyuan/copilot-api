import {
  formatCacheHitRate,
  formatLatency,
  formatOutputSpeed,
  formatTokenCost,
  formatTokenCosts,
} from '../../lib/token-usage-format'
import type {
  TokenUsageEventRecord,
  TokenUsageModelSummary,
  TokenUsageSessionSummary,
} from '../../types/ipc'
import { TokenUsageValueLines } from '../TokenUsageMetric'

import {
  calcTokenTotal,
  formatCellText,
  formatEventTime,
  formatTokenCount,
} from './dashboard-format'

export function TokenUsageModelRow({
  model,
}: {
  model: TokenUsageModelSummary
}) {
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

export function TokenUsageSessionRow({
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

export function TokenUsageEventRow({
  event,
}: {
  event: TokenUsageEventRecord
}) {
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
