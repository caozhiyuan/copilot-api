import { requestContext, generateTraceId } from "~/lib/request-context"
import { state } from "~/lib/state"

import { EventBus } from "../event-bus"
import {
  enqueueTokenUsageWrite,
  hasAnyToken,
  normalizeOptionalToken,
  normalizeToken,
  resolveTotalTokens,
  type CopilotUsage,
  type CopilotUsageTokens,
  type PersistedTokenUsageEvent,
  type TokenUsageEndpoint,
  type TokenUsageSource,
  type TokenUsageTokenDetail,
  type UsageTokens,
} from "./store"

export {
  closeUsageStore,
  getTokenUsageDailySummary,
  getTokenUsageEventsPage,
  getTokenUsageSummary,
} from "./store"

export type {
  CopilotUsage,
  CopilotUsageTokens,
  TokenUsageDailyBucket,
  TokenUsageDailySummary,
  TokenUsageEndpoint,
  TokenUsageEventRecord,
  TokenUsageEventsPage,
  TokenUsageModelSummary,
  TokenUsagePeriod,
  TokenUsageSource,
  TokenUsageTokenDetail,
  TokenUsageSummary,
  TokenUsageTotals,
  UsageTokens,
} from "./store"

export interface TokenUsageEventInput extends UsageTokens {
  copilotUsage?: CopilotUsageTokens | null
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string | null
  model: string
  providerName?: string | null
  sessionId?: string | null
  source: TokenUsageSource
  traceId?: string | null
}

interface TokenUsageRecorderOptions {
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string | null
  model: string
  providerName?: string | null
  sessionId?: string | null
  source: TokenUsageSource
  traceId?: string | null
}

type CopilotTokenUsageRecorderOptions = Omit<
  TokenUsageRecorderOptions,
  "providerName" | "source"
>

type ProviderTokenUsageRecorderOptions = Omit<
  TokenUsageRecorderOptions,
  "source"
>

interface TokenUsageEventMap {
  "token_usage.recorded": PersistedTokenUsageEvent
}

const tokenUsageEventBus = new EventBus<TokenUsageEventMap>()

function resolveTraceId(traceId: string | null | undefined): string {
  return (
    traceId?.trim() || requestContext.getStore()?.traceId || generateTraceId()
  )
}

export function resolveTokenUsageSessionId(
  sessionId: string | null | undefined,
  fallbackSessionId?: string | null,
): string {
  return (
    requestContext.getStore()?.sessionAffinity?.trim()
    || sessionId?.trim()
    || fallbackSessionId?.trim()
    || ""
  )
}

function resolveUserId(input: TokenUsageEventInput): string {
  if (input.source === "provider") {
    return input.providerName?.trim() || ""
  }
  return state.userName?.trim() || ""
}

function resolveTokenDetails(
  details: Array<TokenUsageTokenDetail> | null | undefined,
): {
  nano_cost_cache_read: number | null
  nano_cost_cache_write: number | null
  nano_cost_input: number | null
  nano_cost_output: number | null
} {
  if (!Array.isArray(details)) {
    return {
      nano_cost_cache_read: null,
      nano_cost_cache_write: null,
      nano_cost_input: null,
      nano_cost_output: null,
    }
  }

  const result = {
    nano_cost_cache_read: 0,
    nano_cost_cache_write: 0,
    nano_cost_input: 0,
    nano_cost_output: 0,
  }

  for (const detail of details) {
    if (!detail || typeof detail.token_count !== "number") {
      continue
    }

    const cost =
      Math.round(
        (detail.token_count / Math.max(1, detail.batch_size || 1))
          * (detail.cost_per_batch || 0),
      ) || 0

    switch (detail.token_type) {
      case "input": {
        result.nano_cost_input += cost
        break
      }
      case "cache_read": {
        result.nano_cost_cache_read += cost
        break
      }
      case "cache_write": {
        result.nano_cost_cache_write += cost
        break
      }
      case "output": {
        result.nano_cost_output += cost
        break
      }
    }
  }

  return result
}

function toPersistedEvent(
  input: TokenUsageEventInput,
): PersistedTokenUsageEvent | null {
  if (!hasAnyToken(input)) {
    return null
  }

  const now = new Date()
  const cost = resolveTokenDetails(input.copilotUsage?.token_details)
  return {
    cache_read_input_tokens: normalizeToken(input.cache_read_input_tokens),
    created_at_ms: now.getTime(),
    created_at_utc: now.toISOString(),
    endpoint: input.endpoint,
    input_tokens: normalizeToken(input.input_tokens),
    model: input.model.trim() || "unknown",
    ...cost,
    output_tokens: normalizeToken(input.output_tokens),
    provider_name: input.providerName?.trim() || null,
    session_id: resolveTokenUsageSessionId(
      input.sessionId,
      input.fallbackSessionId,
    ),
    source: input.source,
    total_nano_aiu:
      (
        input.copilotUsage?.total_nano_aiu === undefined
        || input.copilotUsage.total_nano_aiu === null
      ) ?
        null
      : normalizeToken(input.copilotUsage.total_nano_aiu),
    total_tokens: resolveTotalTokens(input),
    trace_id: resolveTraceId(input.traceId),
    user_id: resolveUserId(input),
  }
}

tokenUsageEventBus.subscribe("token_usage.recorded", enqueueTokenUsageWrite)

export function recordTokenUsageEvent(input: TokenUsageEventInput): void {
  const event = toPersistedEvent(input)
  if (!event) {
    return
  }

  tokenUsageEventBus.publish("token_usage.recorded", event)
}

export function createTokenUsageRecorder(
  options: TokenUsageRecorderOptions,
): (usage: UsageTokens, copilotUsage?: CopilotUsageTokens | null) => void {
  return (usage, copilotUsage) => {
    recordTokenUsageEvent({
      ...usage,
      ...options,
      copilotUsage,
    })
  }
}

export function createCopilotTokenUsageRecorder(
  options: CopilotTokenUsageRecorderOptions,
): (usage: UsageTokens, copilotUsage?: CopilotUsageTokens | null) => void {
  return createTokenUsageRecorder({
    ...options,
    source: "copilot",
  })
}

export function createProviderTokenUsageRecorder(
  options: ProviderTokenUsageRecorderOptions,
): (usage: UsageTokens, copilotUsage?: CopilotUsageTokens | null) => void {
  return createTokenUsageRecorder({
    ...options,
    source: "provider",
  })
}

export function normalizeOpenAIUsage(
  usage:
    | {
        completion_tokens?: number
        prompt_tokens?: number
        total_tokens?: number
        prompt_tokens_details?: {
          cached_tokens?: number
        }
      }
    | null
    | undefined,
): UsageTokens {
  const cachedTokens = normalizeToken(
    usage?.prompt_tokens_details?.cached_tokens,
  )
  const promptTokens = normalizeToken(usage?.prompt_tokens)
  return {
    cache_read_input_tokens: cachedTokens,
    input_tokens: Math.max(0, promptTokens - cachedTokens),
    output_tokens: normalizeToken(usage?.completion_tokens),
    total_tokens: normalizeOptionalToken(usage?.total_tokens),
  }
}

export function normalizeResponsesUsage(
  usage:
    | {
        input_tokens?: number
        input_tokens_details?: {
          cached_tokens?: number
        }
        output_tokens?: number
        total_tokens?: number
      }
    | null
    | undefined,
): UsageTokens {
  const cachedTokens = normalizeToken(
    usage?.input_tokens_details?.cached_tokens,
  )
  const inputTokens = normalizeToken(usage?.input_tokens)
  return {
    cache_read_input_tokens: cachedTokens,
    input_tokens: Math.max(0, inputTokens - cachedTokens),
    output_tokens: normalizeToken(usage?.output_tokens),
    total_tokens: normalizeOptionalToken(usage?.total_tokens),
  }
}

export function normalizeAnthropicUsage(
  usage:
    | {
        cache_read_input_tokens?: number
        input_tokens?: number
        output_tokens?: number
        total_tokens?: number
      }
    | null
    | undefined,
): UsageTokens {
  return {
    cache_read_input_tokens: normalizeOptionalToken(
      usage?.cache_read_input_tokens,
    ),
    input_tokens: normalizeOptionalToken(usage?.input_tokens),
    output_tokens: normalizeOptionalToken(usage?.output_tokens),
    total_tokens: normalizeOptionalToken(usage?.total_tokens),
  }
}

export function mergeAnthropicUsage(
  current: UsageTokens,
  next: UsageTokens,
): UsageTokens {
  return {
    cache_read_input_tokens:
      next.cache_read_input_tokens ?? current.cache_read_input_tokens,
    input_tokens: next.input_tokens ?? current.input_tokens,
    output_tokens: next.output_tokens ?? current.output_tokens,
    total_tokens: next.total_tokens ?? current.total_tokens,
  }
}

/**
 * Convert API response CopilotUsage field to CopilotUsageTokens for recorder.
 * Returns empty object when input is absent.
 */
export function copilotUsageToTokens(
  copilotUsage: CopilotUsage | null | undefined,
): CopilotUsageTokens {
  if (!copilotUsage) {
    return {}
  }
  return {
    token_details: copilotUsage.token_details,
    total_nano_aiu: copilotUsage.total_nano_aiu,
  }
}

export function nonEmptyCopilotUsageTokens(
  usage: CopilotUsage | null | undefined,
): CopilotUsageTokens | null {
  const tokens = copilotUsageToTokens(usage)
  return (
      tokens.token_details !== undefined || tokens.total_nano_aiu !== undefined
    ) ?
      tokens
    : null
}

export function copilotUsageFromResponsesEvent(event: {
  copilot_usage?: CopilotUsage | null
  response?: { copilot_usage?: CopilotUsage | null }
}): CopilotUsageTokens | null {
  const topLevelUsage = nonEmptyCopilotUsageTokens(event.copilot_usage)
  if (topLevelUsage) {
    return topLevelUsage
  }

  return nonEmptyCopilotUsageTokens(event.response?.copilot_usage)
}
