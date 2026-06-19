import { requestContext, generateTraceId } from "~/lib/request-context"
import { state } from "~/lib/state"

import { EventBus } from "../event-bus"
import {
  enqueueTokenUsageWrite,
  hasAnyToken,
  normalizeOptionalToken,
  normalizeToken,
  resolveTotalTokens,
  type PersistedTokenUsageEvent,
  type TokenUsageEndpoint,
  type TokenUsageSource,
  type UsageTokens,
} from "./store"

export {
  closeUsageStore,
  getTokenUsageDailySummary,
  getTokenUsageEventsPage,
  getTokenUsageSummary,
  normalizeOptionalToken,
  normalizeToken,
} from "./store"

export type {
  TokenUsageDailyBucket,
  TokenUsageDailySummary,
  TokenUsageEndpoint,
  TokenUsageEventRecord,
  TokenUsageEventsPage,
  TokenUsageModelSummary,
  TokenUsagePeriod,
  TokenUsageSource,
  TokenUsageSummary,
  TokenUsageTotals,
  UsageTokens,
} from "./store"

export interface TokenUsageEventInput extends UsageTokens {
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

function toPersistedEvent(
  input: TokenUsageEventInput,
): PersistedTokenUsageEvent | null {
  if (!hasAnyToken(input)) {
    return null
  }

  const now = new Date()
  return {
    cache_creation_input_tokens: normalizeToken(
      input.cache_creation_input_tokens,
    ),
    cache_read_input_tokens: normalizeToken(input.cache_read_input_tokens),
    created_at_ms: now.getTime(),
    created_at_utc: now.toISOString(),
    endpoint: input.endpoint,
    input_tokens: normalizeToken(input.input_tokens),
    model: input.model.trim() || "unknown",
    output_tokens: normalizeToken(input.output_tokens),
    provider_name: input.providerName?.trim() || null,
    session_id: resolveTokenUsageSessionId(
      input.sessionId,
      input.fallbackSessionId,
    ),
    source: input.source,
    total_nano_aiu:
      input.total_nano_aiu === undefined || input.total_nano_aiu === null ?
        null
      : normalizeToken(input.total_nano_aiu),
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
): (usage: UsageTokens) => void {
  return (usage) => {
    recordTokenUsageEvent({
      ...usage,
      ...options,
    })
  }
}

export function createCopilotTokenUsageRecorder(
  options: CopilotTokenUsageRecorderOptions,
): (usage: UsageTokens) => void {
  return createTokenUsageRecorder({
    ...options,
    source: "copilot",
  })
}

export function createProviderTokenUsageRecorder(
  options: ProviderTokenUsageRecorderOptions,
): (usage: UsageTokens) => void {
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
          cache_creation_input_tokens?: number
          cached_tokens?: number
        }
      }
    | null
    | undefined,
): UsageTokens {
  const cachedTokens = normalizeToken(
    usage?.prompt_tokens_details?.cached_tokens,
  )
  const cacheCreationTokens = normalizeToken(
    usage?.prompt_tokens_details?.cache_creation_input_tokens,
  )
  const promptTokens = normalizeToken(usage?.prompt_tokens)
  return {
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cachedTokens,
    input_tokens: Math.max(
      0,
      promptTokens - cachedTokens - cacheCreationTokens,
    ),
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
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
        input_tokens?: number
        output_tokens?: number
        total_tokens?: number
      }
    | null
    | undefined,
): UsageTokens {
  return {
    cache_creation_input_tokens: normalizeOptionalToken(
      usage?.cache_creation_input_tokens,
    ),
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
    cache_creation_input_tokens:
      next.cache_creation_input_tokens ?? current.cache_creation_input_tokens,
    cache_read_input_tokens:
      next.cache_read_input_tokens ?? current.cache_read_input_tokens,
    input_tokens: next.input_tokens ?? current.input_tokens,
    output_tokens: next.output_tokens ?? current.output_tokens,
    total_tokens: next.total_tokens ?? current.total_tokens,
  }
}
