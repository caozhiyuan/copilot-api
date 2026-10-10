import { builtinProviderModelRegistry } from "../builtin-provider-models"
import { getModelsDevModelPricing } from "../models-dev-cache"
import {
  resolveProviderModelsDevId,
  usesModelsDevModelCatalog,
} from "../provider-model-catalog"
import type { TokenUsagePeakWindow } from "./peak-windows"
import {
  normalizeToken,
  type TokenUsageSource,
  type UsageTokens,
} from "./store"

export type { TokenUsagePeakWindow } from "./peak-windows"

export interface TokenUsagePricingTier {
  cachedInput?: number
  cacheCreationInput?: number
  explicitCachedInput?: number
  input?: number
  maxInputTokens?: number
  output?: number
}

export interface TokenUsagePricingConfig extends TokenUsagePricingTier {
  // Prices billed outside every UTC peak window, for providers that discount
  // off-peak traffic. Ignored unless `peakWindows` is non-empty.
  offPeak?: TokenUsagePricingTier
  peakWindows?: Array<TokenUsagePeakWindow>
  tiers?: Array<TokenUsagePricingTier>
}

export interface CalculatedTokenUsageCost {
  currency: string
  source: string
  total_cost_nanos: number
}

export interface TokenUsageCostInput extends UsageTokens {
  serviceTier?: string | null
  // Timestamp used to pick peak or off-peak prices; defaults to the current
  // time when omitted.
  at?: Date | null
  model: string
  pricing?: TokenUsagePricingConfig | null
  pricingCurrency?: string | null
  providerName?: string | null
  source: TokenUsageSource
}

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
  if (
    input.source === "provider"
    && input.providerName?.trim().toLowerCase() === "openrouter"
  ) {
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

  const resolvedPricing = resolveProviderPricing(
    providerName,
    input.model,
    input.pricing,
  )
  if (!resolvedPricing) {
    return null
  }

  const pricing = resolvePricingTier(
    resolvedPricing.pricing,
    getInputTokenTotal(input),
    resolvePricingTime(input.at),
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
    baseCostNanos * resolveCodexServiceTierMultiplier(input, providerName),
  )

  if (totalCostNanos <= 0) {
    return null
  }

  return {
    currency,
    source: resolvedPricing.source,
    total_cost_nanos: totalCostNanos,
  }
}

function resolveCodexServiceTierMultiplier(
  input: TokenUsageCostInput,
  providerName: string,
): number {
  if (providerName.toLowerCase() !== "codex") {
    return 1
  }

  // Price-estimate multipliers, applied after selecting the context rates.
  // https://developers.openai.com/api/docs/pricing
  switch (input.serviceTier?.trim().toLowerCase()) {
    case "priority":
    case "fast":
      return 2
    case "ultrafast":
      return 6
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

export function getCostAmount(totalCostNanos: number): number {
  return totalCostNanos / COST_NANOS_PER_UNIT
}

function resolveCopilotCost(
  input: TokenUsageCostInput,
): CalculatedTokenUsageCost | null {
  const totalNanoAiu = normalizeToken(input.total_nano_aiu)
  if (totalNanoAiu <= 0) {
    return null
  }

  const totalCostNanos = Math.round(
    totalNanoAiu * COPILOT_NANO_AIU_TO_COST_NANOS,
  )
  if (totalCostNanos <= 0) {
    return null
  }

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
