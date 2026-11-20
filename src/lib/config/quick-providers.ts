import type { ProviderType } from "./index"

interface QuickProviderConfig {
  type: ProviderType
  baseUrl: string
  pricingCurrency: string
  editableType: boolean
}

export const QUICK_PROVIDER_CONFIGS = {
  "opencode-go": {
    type: "openai-compatible",
    baseUrl: "https://opencode.ai/zen/go",
    pricingCurrency: "USD",
    editableType: false,
  },
  kimi: {
    type: "openai-compatible",
    baseUrl: "https://api.kimi.com/coding",
    pricingCurrency: "USD",
    editableType: true,
  },
  deepseek: {
    type: "anthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    pricingCurrency: "CNY",
    editableType: true,
  },
  dashscope: {
    type: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    pricingCurrency: "CNY",
    editableType: true,
  },
  openrouter: {
    type: "anthropic",
    baseUrl: "https://openrouter.ai/api",
    pricingCurrency: "USD",
    editableType: false,
  },
} satisfies Record<string, QuickProviderConfig>

export type QuickProviderName = keyof typeof QUICK_PROVIDER_CONFIGS
