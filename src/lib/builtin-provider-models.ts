import type { TokenUsagePricingConfig } from "./token-usage/pricing"
import { DEFAULT_IMAGE_MODELS } from "./image-models"
import type { CodexReasoningEffort, ModelReasoningField } from "./config-store"
import {
  getOpencodeGoModelConfig,
  getOpencodeGoModelIds,
} from "./models-dev-cache"

export type BuiltinProviderInputModality = "text" | "image"

export interface BuiltinProviderModelConfig {
  contextWindow?: number
  defaultReasoningEffort?: CodexReasoningEffort
  inputModalities?: Array<BuiltinProviderInputModality>
  maxOutputTokens?: number
  pricing?: TokenUsagePricingConfig
  reasoningEfforts?: Array<CodexReasoningEffort>
  supportPdf?: boolean
  // Message field carrying assistant thinking text in upstream requests,
  // for models that do not follow the default "reasoning_content"
  // convention (e.g. opencode-go hy3/hy4 use the OpenRouter-style
  // "reasoning" field)
  reasoningField?: ModelReasoningField
}

type BuiltinProviderModelCatalog = Record<
  string,
  Record<string, BuiltinProviderModelConfig>
>

const CODEX_LUNA_PRICING: TokenUsagePricingConfig = {
  cacheCreationInput: 0.125,
  cachedInput: 0.01,
  input: 0.1,
  output: 0.5,
}

export class BuiltinProviderModelRegistry {
  private static readonly providerDefaults: Record<
    string,
    Readonly<BuiltinProviderModelConfig>
  > = {
    codex: { supportPdf: true },
  }

  private static readonly catalog: BuiltinProviderModelCatalog = {
    // ChatGPT-signed-in Codex has no >272K long-context pricing multiplier.
    // https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing
    codex: {
      "codex-auto-review": { pricing: CODEX_LUNA_PRICING },
      "gpt-reserve": { pricing: CODEX_LUNA_PRICING },
      "gpt-5.6-sol": {
        pricing: {
          cacheCreationInput: 5,
          cachedInput: 0.4,
          input: 4,
          output: 20,
        },
      },
      "gpt-5.6-terra": {
        pricing: {
          cacheCreationInput: 2.5,
          cachedInput: 0.2,
          input: 2,
          output: 12,
        },
      },
      "gpt-5.6-luna": {
        pricing: {
          cacheCreationInput: 0.25,
          cachedInput: 0.02,
          input: 0.2,
          output: 1.2,
        },
      },
      "gpt-6-astra": {
        pricing: {
          cacheCreationInput: 12.5,
          cachedInput: 1,
          input: 10,
          output: 50,
        },
      },
      "gpt-6-luna": {
        pricing: CODEX_LUNA_PRICING,
      },
      "gpt-6-sol": {
        pricing: {
          cacheCreationInput: 2.5,
          cachedInput: 0.2,
          input: 2,
          output: 10,
        },
      },
      "gpt-6.1-sol": {
        pricing: {
          cacheCreationInput: 2.5,
          cachedInput: 0.1,
          input: 2,
          output: 10,
        },
      },
      "gpt-6.1-terra": {
        pricing: {
          cacheCreationInput: 1.25,
          cachedInput: 0.05,
          input: 1,
          output: 5,
        },
      },
    },
  }

  private readonly modelCatalog: BuiltinProviderModelCatalog

  constructor() {
    this.modelCatalog = BuiltinProviderModelRegistry.catalog
  }

  getModelConfig(
    providerName: string,
    modelName: string,
  ): BuiltinProviderModelConfig | undefined {
    const provider = this.normalizeKey(providerName)
    if (provider === "opencode-go") return getOpencodeGoModelConfig(modelName)
    const models = this.modelCatalog[provider]
    return models?.[modelName.trim()] ?? models?.[this.normalizeKey(modelName)]
  }

  getModelIds(providerName: string): Array<string> {
    const provider = this.normalizeKey(providerName)
    if (provider === "opencode-go") return getOpencodeGoModelIds()
    return Object.keys(this.modelCatalog[provider] ?? {})
  }

  getProviderDefaults(
    providerName: string,
  ): Readonly<BuiltinProviderModelConfig> | undefined {
    return BuiltinProviderModelRegistry.providerDefaults[
      this.normalizeKey(providerName)
    ]
  }

  private normalizeKey(value: string): string {
    return value.trim().toLowerCase()
  }
}

export const builtinProviderModelRegistry = new BuiltinProviderModelRegistry()

// Image endpoints support these models even when the upstream chat catalog
// omits them. Keep them separate from models advertised to chat-only clients.
const IMAGE_MODELS: Record<
  string,
  Array<{ id: string; name: string; family: string }>
> = {
  "github-copilot": [
    {
      id: DEFAULT_IMAGE_MODELS["github-copilot"],
      name: "GPT Image 2.5 Flare",
      family: "gpt-image",
    },
  ],
  codex: [
    {
      id: DEFAULT_IMAGE_MODELS.codex,
      name: "GPT Image 2",
      family: "gpt-image",
    },
  ],
  xai: [
    {
      id: DEFAULT_IMAGE_MODELS.xai,
      name: "Grok Imagine Image 2.0",
      family: "grok-imagine",
    },
  ],
}

export function getBuiltinProviderImageModelRecords(
  provider: string,
): Array<Record<string, unknown>> {
  return (IMAGE_MODELS[provider] ?? []).map((model) => ({
    ...model,
    object: "model",
    type: "image",
    input_modalities: ["text", "image"],
    output_modalities: ["image"],
  }))
}

export function getBuiltinProviderModelRecords(
  provider: string,
): Array<Record<string, unknown>> {
  return builtinProviderModelRegistry.getModelIds(provider).map((id) => {
    const config = builtinProviderModelRegistry.getModelConfig(provider, id)
    return {
      id,
      name: id,
      object: "model",
      context_window: config?.contextWindow,
      max_output_tokens: config?.maxOutputTokens,
      input_modalities: config?.inputModalities,
      reasoning_efforts: config?.reasoningEfforts,
    }
  })
}
