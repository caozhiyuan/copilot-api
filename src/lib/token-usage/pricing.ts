import { builtinProviderModelRegistry } from "../catalog/builtin-provider-models"
import { getModelsDevModelPricing } from "../catalog/models-dev-cache"
import {
  resolveProviderModelsDevId,
  usesModelsDevModelCatalog,
} from "../catalog/provider-model-catalog"
import type {
  CalculatedTokenUsageCost,
  TokenUsageCostInput,
  TokenUsagePeakWindow,
  TokenUsagePricingConfig,
  TokenUsagePricingTier,
} from "../types/pricing"
import type { UsageTokens } from "../types/token-usage"
import {
  resolveBuiltinImageCost,
  hasBuiltinImagePricing,
} from "./image-pricing"
import { normalizeToken } from "./normalize"

export type {
  CalculatedTokenUsageCost,
  TokenUsageCostInput,
  TokenUsagePeakWindow,
  TokenUsagePricingConfig,
  TokenUsagePricingTier,
} from "../types/pricing"

interface ResolvedPricing {
  pricing: TokenUsagePricingConfig
  source: string
  currency?: string
}

const COST_NANOS_PER_UNIT = 1_000_000_000
const COST_NANOS_PER_TOKEN_AT_ONE_PER_MILLION = 1_000
const COPILOT_NANO_AIU_PER_USD = 100_000_000_000
const COPILOT_NANO_AIU_TO_COST_NANOS =
  COST_NANOS_PER_UNIT / COPILOT_NANO_AIU_PER_USD
// The GPT-6.2 Ultrafast promotion ends at midnight Pacific time on March 1.
const CODEX_GPT_62_ULTRAFAST_PROMOTION_END = Date.UTC(2027, 2, 1, 8)
const BUILTIN_PROVIDER_CURRENCIES: Record<string, string> = {
  codex: "USD",
  dashscope: "CNY",
  deepseek: "CNY",
  kimi: "USD",
  "opencode-go": "USD",
}

export function resolveTokenUsageCost(
  input: TokenUsageCostInput,
): CalculatedTokenUsageCost | null {
  if (input.endpoint === "alpha_search") {
    const cost = normalizePrice(input.cost)
    if (cost === null) return null
    return {
      currency: input.pricingCurrency === "CNY" ? "CNY" : "USD",
      source: input.providerName === "codex" ? "builtin" : "estimate",
      total_cost_nanos: Math.round(cost * COST_NANOS_PER_UNIT),
    }
  }
  if (input.source === "provider") {
    const reportedCost = resolveReportedProviderCost(input)
    if (reportedCost) {
      return reportedCost
    }
  }

  if (input.source === "copilot") {
    return resolveCopilotCost(input)
  }

  const providerName = input.providerName?.trim()
  if (!providerName) {
    return null
  }

  if (
    providerName.toLowerCase() === "codex"
    && !input.pricing
    && (input.endpoint === "images_generations"
      || input.endpoint === "images_edits")
  ) {
    return resolveBuiltinImageCost(input)
  }

  const resolvedPricing = resolveProviderPricing(
    providerName,
    input.model,
    input.pricing,
  )
  if (!resolvedPricing) {
    return null
  }

  const at = resolvePricingTime(input.at)
  const pricing = resolvePricingTier(
    resolvedPricing.pricing,
    getInputTokenTotal(input),
    at,
  )
  const currency =
    resolvedPricing.currency
    ?? resolveProviderCurrency(providerName, input.pricingCurrency)
  if (!currency) {
    return null
  }

  const inputPrice = normalizePrice(pricing.input)
  const outputPrice = normalizePrice(pricing.output)
  const cacheReadPrice = resolveCacheReadPrice(pricing, input)
  const cacheCreationPrice = resolveCacheCreationPrice(pricing)

  const baseCostNanos =
    costNanosForTokens(input.input_tokens, inputPrice)
    + costNanosForTokens(input.output_tokens, outputPrice)
    + costNanosForTokens(input.cache_read_input_tokens, cacheReadPrice)
    + costNanosForTokens(input.cache_creation_input_tokens, cacheCreationPrice)
  const totalCostNanos = Math.round(
    baseCostNanos * resolveCodexServiceTierMultiplier(input, providerName, at),
  )
  if (
    totalCostNanos <= 0
    && !(
      inputPrice === 0
      && (outputPrice === 0 || input.endpoint === "embeddings")
    )
  )
    return null

  return {
    currency,
    source: resolvedPricing.source,
    total_cost_nanos: totalCostNanos,
  }
}

function resolveCodexServiceTierMultiplier(
  input: TokenUsageCostInput,
  providerName: string,
  at: Date,
): number {
  if (providerName.toLowerCase() !== "codex") {
    return 1
  }

  // Price-estimate multipliers, applied after selecting the context rates.
  // https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing
  switch (input.serviceTier?.trim().toLowerCase()) {
    case "priority":
    case "fast":
      return 2
    case "ultrafast": {
      const model = input.model.trim().toLowerCase()
      const hasPromotionalRate =
        (model === "gpt-6.2-sol" || model === "gpt-6.2-astra")
        && at.getTime() < CODEX_GPT_62_ULTRAFAST_PROMOTION_END
      return hasPromotionalRate ? 3 : 6
    }
    default:
      return 1
  }
}

function resolveReportedProviderCost(
  input: TokenUsageCostInput,
): CalculatedTokenUsageCost | null {
  const cost = normalizePrice(input.cost)
  if (cost === null) {
    return null
  }

  const totalCostNanos = Math.round(cost * COST_NANOS_PER_UNIT)
  if (totalCostNanos < 0) {
    return null
  }

  return {
    currency: "USD",
    source: "upstream",
    total_cost_nanos: totalCostNanos,
  }
}

export function xaiUsdTicksToCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ?
      value / 10_000_000_000
    : undefined
}

// Admission uses the same pricing sources as settlement. Providers with
// normalized, reported USD costs do not need an estimated token price.
export function getTokenUsagePricingCurrency(
  input: Pick<
    TokenUsageCostInput,
    | "model"
    | "source"
    | "providerName"
    | "pricing"
    | "pricingCurrency"
    | "endpoint"
  > & { baseUrl?: string },
): string | null {
  const provider = input.providerName ?? "github-copilot"
  // Embeddings currently report tokens but no Copilot AIU charge.
  if (input.source === "copilot" && input.endpoint === "embeddings") return null
  if (input.endpoint === "alpha_search") {
    if (provider === "codex") return "USD"
    return (
        provider === "deepseek"
          && /^https:\/\/api\.deepseek\.com(?:\/anthropic)?(?:\/v1)?\/?$/u.test(
            input.baseUrl ?? "",
          )
      ) ?
        (input.pricingCurrency ?? "CNY").toUpperCase()
      : null
  }
  if (
    input.source === "copilot"
    || provider === "xai"
    || provider === "openrouter"
  )
    return "USD"
  if (input.endpoint === "videos_generations") return null
  if (
    input.endpoint === "images_generations"
    || input.endpoint === "images_edits"
  ) {
    if (
      provider === "codex"
      && !input.pricing
      && hasBuiltinImagePricing(input.model)
    )
      return "USD"
  }
  const resolved = resolveProviderPricing(provider, input.model, input.pricing)
  if (!resolved) return null
  const tiers =
    resolved.pricing.tiers?.length ? resolved.pricing.tiers : [resolved.pricing]
  const rates = tiers.map((tier) => ({ ...resolved.pricing, ...tier }))
  if (resolved.pricing.offPeak && resolved.pricing.peakWindows?.length)
    rates.push(
      ...rates.map((tier) => ({ ...tier, ...resolved.pricing.offPeak })),
    )
  if (
    rates.some(
      (tier) =>
        normalizePrice(tier.input ?? resolved.pricing.input) === null
        || (input.endpoint !== "embeddings"
          && normalizePrice(tier.output ?? resolved.pricing.output) === null),
    )
  )
    return null
  return (
    resolved.currency
    ?? resolveProviderCurrency(provider, input.pricingCurrency)
  )
}

function resolveCopilotCost(
  input: TokenUsageCostInput,
): CalculatedTokenUsageCost | null {
  const totalNanoAiu = normalizePrice(input.total_nano_aiu)
  if (totalNanoAiu === null) {
    return null
  }

  const totalCostNanos = Math.round(
    totalNanoAiu * COPILOT_NANO_AIU_TO_COST_NANOS,
  )
  return {
    currency: "USD",
    source: "copilot_aiu",
    total_cost_nanos: totalCostNanos,
  }
}

function resolveProviderPricing(
  providerName: string,
  model: string,
  configuredPricing: TokenUsagePricingConfig | null | undefined,
): ResolvedPricing | null {
  if (configuredPricing) {
    return {
      pricing: configuredPricing,
      source: "config",
    }
  }

  if (usesModelsDevModelCatalog(providerName)) {
    const pricing = getModelsDevModelPricing(
      resolveProviderModelsDevId(providerName),
      model,
    )
    if (pricing) return { pricing, source: "models.dev", currency: "USD" }
  }

  const pricingModel =
    (
      providerName.toLowerCase() === "codex"
      && model.trim().toLowerCase() === "gpt-5.6"
    ) ?
      "gpt-5.6-sol"
    : model
  const builtinPricing = builtinProviderModelRegistry.getModelConfig(
    providerName,
    pricingModel,
  )?.pricing
  if (!builtinPricing) {
    return null
  }

  return {
    pricing: builtinPricing,
    source: "builtin",
  }
}

function resolvePricingTier(
  pricing: TokenUsagePricingConfig,
  inputTokenTotal: number,
  at: Date,
): TokenUsagePricingTier {
  const tiers = pricing.tiers
    ?.filter((tier) => typeof tier === "object" && tier !== null)
    .toSorted((a, b) => normalizeTierMax(a) - normalizeTierMax(b))

  const selectedTier =
    tiers?.find((tier) => inputTokenTotal <= normalizeTierMax(tier))
    ?? tiers?.at(-1)

  const resolvedTier = {
    ...pricing,
    ...selectedTier,
  }

  const offPeak = pricing.offPeak
  const peakWindows = pricing.peakWindows
  if (offPeak && peakWindows?.length && !isPeakPricingTime(peakWindows, at)) {
    return { ...resolvedTier, ...offPeak }
  }

  return resolvedTier
}

function resolvePricingTime(at: Date | null | undefined): Date {
  return at instanceof Date && Number.isFinite(at.getTime()) ? at : new Date()
}

// Peak windows are matched against UTC minutes and ISO weekdays so a catalog
// entry bills the same no matter which timezone the host runs in.
export function isPeakPricingTime(
  windows: Array<TokenUsagePeakWindow>,
  at: Date,
): boolean {
  const minuteOfDay = at.getUTCHours() * 60 + at.getUTCMinutes()
  const isoWeekday = at.getUTCDay() || 7

  return windows.some((window) => {
    const startMinute = normalizeMinuteOfDay(window.startMinuteUtc)
    const endMinute = normalizeMinuteOfDay(window.endMinuteUtc)
    if (
      startMinute === null
      || endMinute === null
      || endMinute <= startMinute
    ) {
      return false
    }

    if (window.weekdays?.length && !window.weekdays.includes(isoWeekday)) {
      return false
    }

    return minuteOfDay >= startMinute && minuteOfDay < endMinute
  })
}

function normalizeMinuteOfDay(value: number | undefined): number | null {
  return (
      typeof value === "number"
        && Number.isFinite(value)
        && value >= 0
        && value <= 1_440
    ) ?
      value
    : null
}

function normalizeTierMax(tier: TokenUsagePricingTier): number {
  const maxInputTokens = tier.maxInputTokens
  return (
      typeof maxInputTokens === "number"
        && Number.isFinite(maxInputTokens)
        && maxInputTokens > 0
    ) ?
      maxInputTokens
    : Number.POSITIVE_INFINITY
}

function getInputTokenTotal(input: UsageTokens): number {
  return (
    normalizeToken(input.input_tokens)
    + normalizeToken(input.cache_read_input_tokens)
    + normalizeToken(input.cache_creation_input_tokens)
  )
}

function normalizePrice(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ?
      value
    : null
}

export function resolveProviderCurrency(
  providerName: string,
  configuredCurrency: string | null | undefined,
): string | null {
  const currency =
    configuredCurrency?.trim().toUpperCase()
    || BUILTIN_PROVIDER_CURRENCIES[providerName.toLowerCase()]
  return currency || null
}

function resolveCacheCreationPrice(
  pricing: TokenUsagePricingTier,
): number | null {
  return normalizePrice(pricing.cacheCreationInput)
}

function resolveCacheReadPrice(
  pricing: TokenUsagePricingTier,
  input: UsageTokens,
): number | null {
  const hasCacheCreationSignal =
    input.cache_creation_input_tokens !== undefined
    && input.cache_creation_input_tokens !== null

  if (hasCacheCreationSignal) {
    const explicitPrice = normalizePrice(pricing.explicitCachedInput)
    if (explicitPrice !== null) {
      return explicitPrice
    }
  }

  return normalizePrice(pricing.cachedInput)
}

function costNanosForTokens(
  tokens: number | null | undefined,
  pricePerMillionTokens: number | null,
): number {
  if (pricePerMillionTokens === null) {
    return 0
  }

  return Math.round(
    normalizeToken(tokens)
      * pricePerMillionTokens
      * COST_NANOS_PER_TOKEN_AT_ONE_PER_MILLION,
  )
}
