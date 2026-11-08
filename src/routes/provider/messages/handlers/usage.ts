import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"

import { type ModelConfig } from "~/lib/config"

import {
  createProviderTokenUsageRecorder,
  type TokenUsageEndpoint,
} from "~/lib/token-usage"

export const createProviderMessagesUsageRecorder = (
  payload: AnthropicMessagesPayload,
  provider: string,
  modelConfig: ModelConfig | undefined,
  pricingCurrency: string | undefined,
  endpoint: TokenUsageEndpoint = "provider_messages",
) =>
  createProviderTokenUsageRecorder({
    endpoint,
    model: payload.model,
    pricing: modelConfig?.pricing,
    pricingCurrency,
    providerName: provider,
  })
