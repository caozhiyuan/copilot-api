import { requestContext, generateTraceId } from "~/lib/request-context"
import { state } from "~/lib/state"

import { EventBus } from "../event-bus"
import { resolveTokenUsageCost, type TokenUsagePricingConfig } from "./pricing"
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
  getTokenUsageSessionsPage,
  getTokenUsageSummary,
  normalizeOptionalToken,
  normalizeToken,
} from "./store"

export type {
  TokenUsageDailyBucket,
  TokenUsageDailySummary,
  TokenUsageCost,
  TokenUsageEventCost,
  TokenUsageEndpoint,
  TokenUsageEventRecord,
  TokenUsageEventsPage,
  TokenUsageModelSummary,
  TokenUsagePeriod,
  TokenUsageSessionsPage,
  TokenUsageSessionSummary,
  TokenUsageSource,
  TokenUsageSummary,
  TokenUsageTotals,
  UsageTokens,
} from "./store"

export interface TokenUsageEventInput extends UsageTokens {
  serviceTier?: string | null
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string | null
  model: string
  pricing?: TokenUsagePricingConfig | null
  pricingCurrency?: string | null
  providerName?: string | null
  sessionId?: string | null
  source: TokenUsageSource
  traceId?: string | null
}

interface TokenUsageRecorderOptions {
  serviceTier?: string | null
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string | null
  model: string
  pricing?: TokenUsagePricingConfig | null
  pricingCurrency?: string | null
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
const USER_AGENT_MAX_LENGTH = 64

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
  const timing = requestContext.getStore()?.requestTiming
  const cost = resolveTokenUsageCost({ ...input, at: now })
  return {
    request_id: timing?.id ?? null,
    first_token_ms: timing?.firstTokenMs ?? null,
    duration_ms: timing?.durationMs ?? null,
    request_outcome: timing?.outcome ?? null,
    cache_creation_input_tokens: normalizeToken(
      input.cache_creation_input_tokens,
    ),
    cache_read_input_tokens: normalizeToken(input.cache_read_input_tokens),
    cost_currency: cost?.currency ?? null,
    cost_source: cost?.source ?? null,
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
    total_cost_nanos: cost?.total_cost_nanos ?? null,
    total_tokens: resolveTotalTokens(input),
    trace_id: resolveTraceId(input.traceId),
    user_agent: (requestContext.getStore()?.userAgent ?? "").slice(
      0,
      USER_AGENT_MAX_LENGTH,
    ),
    user_id: resolveUserId(input),
  }
}

tokenUsageEventBus.subscribe("token_usage.recorded", enqueueTokenUsageWrite)

export function recordTokenUsageEvent(input: TokenUsageEventInput): void {
  const event = toPersistedEvent(input)
  if (!event) {
    return
  }

  const observer = requestContext.getStore()?.pluginRequest
  const timing = requestContext.getStore()?.requestTiming
  if (timing) timing.hasUsage = true
  observer?.setSessionId(event.session_id)
  observer?.recordUsage(event)
  tokenUsageEventBus.publish("token_usage.recorded", event)
}

export function createTokenUsageRecorder(
  options: TokenUsageRecorderOptions,
): (usage: UsageTokens) => void {
  requestContext
    .getStore()
    ?.pluginRequest?.setSessionId(
      resolveTokenUsageSessionId(options.sessionId, options.fallbackSessionId),
    )
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
        prompt_cache_hit_tokens?: number
        prompt_cache_miss_tokens?: number
        prompt_tokens_details?: {
          cache_creation_input_tokens?: number
          cached_tokens?: number
        }
      }
    | null
    | undefined,
): UsageTokens {
  if (
    usage
    && (Object.hasOwn(usage, "prompt_cache_hit_tokens")
      || Object.hasOwn(usage, "prompt_cache_miss_tokens"))
  ) {
    return {
      cache_read_input_tokens: normalizeToken(usage.prompt_cache_hit_tokens),
      input_tokens: normalizeToken(usage.prompt_cache_miss_tokens),
      output_tokens: normalizeToken(usage.completion_tokens),
      total_tokens: normalizeOptionalToken(usage.total_tokens),
    }
  }

  const promptDetails = usage?.prompt_tokens_details
  const hasCacheCreationTokens = Boolean(
    promptDetails
      && Object.hasOwn(promptDetails, "cache_creation_input_tokens"),
  )
  const hasCachedTokens = Boolean(
    promptDetails && Object.hasOwn(promptDetails, "cached_tokens"),
  )
  const cachedTokens = normalizeToken(promptDetails?.cached_tokens)
  const cacheCreationTokens = normalizeToken(
    promptDetails?.cache_creation_input_tokens,
  )
  const promptTokens = normalizeToken(usage?.prompt_tokens)
  return {
    ...(hasCacheCreationTokens && {
      cache_creation_input_tokens: cacheCreationTokens,
    }),
    ...(hasCachedTokens && {
      cache_read_input_tokens: cachedTokens,
    }),
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
        cost?: number
        input_tokens?: number
        input_tokens_details?: {
          cached_tokens?: number
          cache_write_tokens?: number
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
  const cacheWriteTokens = normalizeToken(
    usage?.input_tokens_details?.cache_write_tokens,
  )
  const inputTokens = normalizeToken(usage?.input_tokens)
  return {
    ...(cacheWriteTokens > 0 && {
      cache_creation_input_tokens: cacheWriteTokens,
    }),
    cache_read_input_tokens: cachedTokens,
    cost: normalizeOptionalCost(usage?.cost),
    input_tokens: Math.max(0, inputTokens - cachedTokens - cacheWriteTokens),
    output_tokens: normalizeToken(usage?.output_tokens),
    total_tokens: normalizeOptionalToken(usage?.total_tokens),
  }
}

export function normalizeAnthropicUsage(
  usage:
    | {
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
        cost?: number
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
    cost: normalizeOptionalCost(usage?.cost),
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
    cost: next.cost ?? current.cost,
    input_tokens: next.input_tokens ?? current.input_tokens,
    output_tokens: next.output_tokens ?? current.output_tokens,
    total_nano_aiu: next.total_nano_aiu ?? current.total_nano_aiu,
    total_tokens: next.total_tokens ?? current.total_tokens,
  }
}

function normalizeOptionalCost(
  value: number | null | undefined,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ?
      value
    : undefined
}
