import type { TokenUsagePricingConfig } from "./token-usage/pricing"
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
  tiers: [
    {
      cacheCreationInput: 0.125,
      cachedInput: 0.01,
      input: 0.1,
      maxInputTokens: 272_000,
      output: 0.5,
    },
    {
      cacheCreationInput: 0.25,
      cachedInput: 0.02,
      input: 0.2,
      output: 0.75,
    },
  ],
}

export class BuiltinProviderModelRegistry {
  private static readonly providerDefaults: Record<
    string,
    Readonly<BuiltinProviderModelConfig>
  > = {
    codex: { supportPdf: true },
  }

  private static readonly catalog: BuiltinProviderModelCatalog = {
    codex: {
      "codex-auto-review": { pricing: CODEX_LUNA_PRICING },
      "gpt-reserve": { pricing: CODEX_LUNA_PRICING },
      "gpt-5.5": {
        pricing: {
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
      },
      "gpt-5.6-sol": {
        pricing: {
          tiers: [
            {
              cacheCreationInput: 5,
              cachedInput: 0.4,
              input: 4,
              maxInputTokens: 272_000,
              output: 20,
            },
            {
              cacheCreationInput: 10,
              cachedInput: 0.8,
              input: 8,
              output: 30,
            },
          ],
        },
      },
      "gpt-5.6-terra": {
        pricing: {
          tiers: [
            {
              cacheCreationInput: 2.5,
              cachedInput: 0.2,
              input: 2,
              maxInputTokens: 272_000,
              output: 12,
            },
            {
              cacheCreationInput: 5,
              cachedInput: 0.4,
              input: 4,
              output: 18,
            },
          ],
        },
      },
      "gpt-5.6-luna": {
        pricing: {
          tiers: [
            {
              cacheCreationInput: 0.25,
              cachedInput: 0.02,
              input: 0.2,
              maxInputTokens: 272_000,
              output: 1.2,
            },
            {
              cacheCreationInput: 0.5,
              cachedInput: 0.04,
              input: 0.4,
              output: 1.8,
            },
          ],
        },
      },
      "gpt-6-astra": {
        pricing: {
          tiers: [
            {
              cacheCreationInput: 12.5,
              cachedInput: 1,
              input: 10,
              maxInputTokens: 272_000,
              output: 50,
            },
            {
              cacheCreationInput: 25,
              cachedInput: 2,
              input: 20,
              output: 75,
            },
          ],
        },
      },
      "gpt-6-luna": {
        pricing: CODEX_LUNA_PRICING,
      },
      "gpt-6-sol": {
        pricing: {
          tiers: [
            {
              cacheCreationInput: 2.5,
              cachedInput: 0.2,
              input: 2,
              maxInputTokens: 272_000,
              output: 10,
            },
            {
              cacheCreationInput: 5,
              cachedInput: 0.4,
              input: 4,
              output: 15,
            },
          ],
        },
      },
      "gpt-6.1-sol": {
        pricing: {
          tiers: [
            {
              cacheCreationInput: 2.5,
              cachedInput: 0.1,
              input: 2,
              maxInputTokens: 272_000,
              output: 10,
            },
            {
              cacheCreationInput: 5,
              cachedInput: 0.2,
              input: 4,
              output: 15,
            },
          ],
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
