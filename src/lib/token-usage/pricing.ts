import type {
  TokenUsagePricingConfig,
  TokenUsagePricingTier,
} from "~/lib/config"

import {
  normalizeToken,
  type TokenUsageSource,
  type UsageTokens,
} from "./store"

export interface CalculatedTokenUsageCost {
  currency: string
  source: string
  total_cost_nanos: number
}

interface TokenUsageCostInput extends UsageTokens {
  model: string
  pricing?: TokenUsagePricingConfig | null
  pricingCurrency?: string | null
  providerName?: string | null
  source: TokenUsageSource
}

interface ResolvedPricing {
  pricing: TokenUsagePricingConfig
  source: string
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
  "opencode-go": "USD",
}

const BUILTIN_PROVIDER_PRICING: Record<
  string,
  Record<string, TokenUsagePricingConfig>
> = {
  codex: {
    "gpt-5.3-codex": {
      cachedInput: 0.175,
      input: 1.75,
      output: 14,
    },
    "gpt-5.4": {
      tiers: [
        {
          cachedInput: 0.25,
          input: 2.5,
          maxInputTokens: 272_000,
          output: 15,
        },
        {
          cachedInput: 0.5,
          input: 5,
          output: 22.5,
        },
      ],
    },
    "gpt-5.4-mini": {
      tiers: [
        {
          cachedInput: 0.075,
          input: 0.75,
          maxInputTokens: 272_000,
          output: 4.5,
        },
        {
          cachedInput: 0.15,
          input: 1.5,
          output: 6.75,
        },
      ],
    },
    "gpt-5.5": {
      tiers: [
        {
          cachedInput: 0.5,
          input: 5,
          maxInputTokens: 272_000,
          output: 30,
        },
        {
          cachedInput: 1,
          input: 10,
          output: 45,
        },
      ],
    },
    "gpt-5.6-sol": {
      tiers: [
        {
          cacheCreationInput: 6.25,
          cachedInput: 0.5,
          input: 5,
          maxInputTokens: 272_000,
          output: 30,
        },
        {
          cacheCreationInput: 12.5,
          cachedInput: 1,
          input: 10,
          output: 45,
        },
      ],
    },
    "gpt-5.6-terra": {
      tiers: [
        {
          cacheCreationInput: 3.125,
          cachedInput: 0.25,
          input: 2.5,
          maxInputTokens: 272_000,
          output: 15,
        },
        {
          cacheCreationInput: 6.25,
          cachedInput: 0.5,
          input: 5,
          output: 22.5,
        },
      ],
    },
    "gpt-5.6-luna": {
      tiers: [
        {
          cacheCreationInput: 1.25,
          cachedInput: 0.1,
          input: 1,
          maxInputTokens: 272_000,
          output: 6,
        },
        {
          cacheCreationInput: 2.5,
          cachedInput: 0.2,
          input: 2,
          output: 9,
        },
      ],
    },
  },
  dashscope: {
    "glm-5.1": {
      tiers: [
        {
          cachedInput: 1.2,
          cacheCreationInput: 7.5,
          explicitCachedInput: 0.6,
          input: 6,
          maxInputTokens: 32_000,
          output: 24,
        },
        {
          cachedInput: 1.6,
          cacheCreationInput: 10,
          explicitCachedInput: 0.8,
          input: 8,
          maxInputTokens: 200_000,
          output: 28,
        },
      ],
    },
    "glm-5.2": {
      cachedInput: 2,
      cacheCreationInput: 10,
      explicitCachedInput: 0.8,
      input: 8,
      output: 28,
    },
    "qwen3.7-max": {
      cachedInput: 2.4,
      cacheCreationInput: 15,
      explicitCachedInput: 1.2,
      input: 12,
      output: 36,
    },
    "qwen3.7-plus": {
      tiers: [
        {
          cachedInput: 0.4,
          cacheCreationInput: 2.5,
          explicitCachedInput: 0.2,
          input: 2,
          maxInputTokens: 256_000,
          output: 8,
        },
        {
          cachedInput: 1.2,
          cacheCreationInput: 7.5,
          explicitCachedInput: 0.6,
          input: 6,
          maxInputTokens: 1_000_000,
          output: 24,
        },
      ],
    },
  },
  deepseek: {
    "deepseek-v4-flash": {
      cachedInput: 0.02,
      input: 1,
      output: 2,
    },
    "deepseek-v4-pro": {
      cachedInput: 0.025,
      input: 3,
      output: 6,
    },
  },
  "opencode-go": {
    "glm-5.2": {
      cachedInput: 0.26,
      input: 1.4,
      output: 4.4,
    },
    "grok-4.5": {
      tiers: [
        {
          cachedInput: 0.5,
          input: 2,
          maxInputTokens: 200_000,
          output: 6,
        },
        {
          cachedInput: 1,
          input: 4,
          output: 12,
        },
      ],
    },
    "deepseek-v4-flash": {
      cachedInput: 0.0028,
      input: 0.14,
      output: 0.28,
    },
    "deepseek-v4-pro": {
      cachedInput: 0.0145,
      input: 1.74,
      output: 3.48,
    },
    "kimi-k2.7-code": {
      cachedInput: 0.19,
      input: 0.95,
      output: 4,
    },
    "kimi-k3": {
      cachedInput: 0.3,
      input: 3,
      output: 15,
    },
    "mimo-v2.5": {
      cachedInput: 0.0028,
      input: 0.14,
      output: 0.28,
    },
    "mimo-v2.5-pro": {
      cachedInput: 0.0145,
      input: 1.74,
      output: 3.48,
    },
    "qwen3.7-plus": {
      tiers: [
        {
          cacheCreationInput: 0.5,
          cachedInput: 0.04,
          input: 0.4,
          maxInputTokens: 200_000,
          output: 1.6,
        },
        {
          cacheCreationInput: 1.5,
          cachedInput: 0.12,
          input: 1.2,
          maxInputTokens: 256_000,
          output: 4.8,
        },
      ],
    },
    "qwen3.7-max": {
      cacheCreationInput: 3.125,
      cachedInput: 0.5,
      input: 2.5,
      output: 7.5,
    },
    "minimax-m2.7": {
      cacheCreationInput: 0.375,
      cachedInput: 0.06,
      input: 0.3,
      output: 1.2,
    },
    "minimax-m3": {
      cachedInput: 0.12,
      input: 0.6,
      output: 2.4,
    },
  },
}

export function resolveTokenUsageCost(
  input: TokenUsageCostInput,
): CalculatedTokenUsageCost | null {
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
  )
  const currency = resolveProviderCurrency(providerName, input.pricingCurrency)
  if (!currency) {
    return null
  }

  const inputPrice = normalizePrice(pricing.input)
  const outputPrice = normalizePrice(pricing.output)
  const cacheReadPrice = resolveCacheReadPrice(pricing, input)
  const cacheCreationPrice = resolveCacheCreationPrice(pricing)

  const totalCostNanos =
    costNanosForTokens(input.input_tokens, inputPrice)
    + costNanosForTokens(input.output_tokens, outputPrice)
    + costNanosForTokens(input.cache_read_input_tokens, cacheReadPrice)
    + costNanosForTokens(input.cache_creation_input_tokens, cacheCreationPrice)

  if (totalCostNanos <= 0) {
    return null
  }

  return {
    currency,
    source: resolvedPricing.source,
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

  const builtinPricing =
    BUILTIN_PROVIDER_PRICING[providerName.toLowerCase()]?.[model.toLowerCase()]
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
): TokenUsagePricingTier {
  const tiers = pricing.tiers
    ?.filter((tier) => typeof tier === "object" && tier !== null)
    .toSorted((a, b) => normalizeTierMax(a) - normalizeTierMax(b))

  const selectedTier =
    tiers?.find((tier) => inputTokenTotal <= normalizeTierMax(tier))
    ?? tiers?.at(-1)

  return {
    ...pricing,
    ...selectedTier,
  }
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

function normalizePrice(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ?
      value
    : null
}

function resolveProviderCurrency(
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
