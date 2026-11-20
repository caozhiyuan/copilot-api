import type {
  TokenUsageEndpoint,
  TokenUsageSource,
  UsageTokens,
} from "./token-usage"

// Configured peak-pricing windows use UTC minutes and ISO weekdays so the
// schedule is independent of the host timezone.
export interface TokenUsagePeakWindow {
  // Exclusive end of the peak window, in minutes from 00:00 UTC.
  endMinuteUtc: number
  // Inclusive start of the peak window, in minutes from 00:00 UTC.
  startMinuteUtc: number
  // ISO weekday numbers, 1 = Monday ... 7 = Sunday. Omitted means every day.
  weekdays?: Array<number>
}

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
  endpoint?: TokenUsageEndpoint
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
