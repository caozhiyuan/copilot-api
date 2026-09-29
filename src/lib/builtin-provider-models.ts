import {
  dashscopePeakWindows,
  deepseekPeakWindows,
} from "./token-usage/peak-windows"
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

export class BuiltinProviderModelRegistry {
  private static readonly catalog: BuiltinProviderModelCatalog = {
    codex: {
      "gpt-5.3-codex": {
        pricing: {
          cachedInput: 0.175,
          input: 1.75,
          output: 14,
        },
      },
      "gpt-5.4": {
        pricing: {
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
      },
      "gpt-5.4-mini": {
        pricing: {
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
      },
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
        pricing: {
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
        },
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
    dashscope: {
      "glm-5.3": {
        contextWindow: 1_000_000,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 2,
          input: 8,
          output: 28,
        },
        reasoningEfforts: ["low", "high", "max"],
      },
      "deepseek-v4.1-flash": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 393_216,
        pricing: {
          cachedInput: 0.2,
          input: 2,
          offPeak: {
            cachedInput: 0.1,
            input: 1,
            output: 4,
          },
          output: 8,
          peakWindows: dashscopePeakWindows,
        },
      },
      "qwen3.8-max": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 1.5,
          cacheCreationInput: 15,
          explicitCachedInput: 1,
          input: 12,
          output: 36,
        },
      },
      "qwen3.8-max-0902": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 131_072,
        pricing: {
          cachedInput: 1.5,
          cacheCreationInput: 15,
          explicitCachedInput: 1,
          input: 12,
          output: 36,
        },
      },
      "qwen3.8-flash": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 131_072,
        pricing: {
          cachedInput: 0.1,
          cacheCreationInput: 1.25,
          explicitCachedInput: 0.1,
          input: 0.8,
          output: 2.7,
        },
      },
      "qwen3.7-plus": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
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
      "kimi/kimi-k3": {
        contextWindow: 1_048_576,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 2,
          input: 20,
          output: 100,
        },
      },
      "ZHIPU/GLM-5.3": {
        contextWindow: 1_048_576,
        inputModalities: ["text"],
        maxOutputTokens: 131_072,
        pricing: {
          cachedInput: 2,
          input: 8,
          output: 28,
        },
        reasoningEfforts: ["low", "high", "max"],
      },
      "ZHIPU/GLM-5.3-Flash": {
        contextWindow: 1_048_576,
        inputModalities: ["text", "image"],
        maxOutputTokens: 131_072,
        pricing: {
          cachedInput: 0.23,
          input: 0.8,
          output: 2.8,
        },
        reasoningEfforts: ["low", "high", "max"],
      },
      "ZHIPU/GLM-5.3-FlashX": {
        contextWindow: 1_048_576,
        inputModalities: ["text", "image"],
        maxOutputTokens: 131_072,
        pricing: {
          cachedInput: 0.57,
          input: 2,
          output: 7,
        },
        reasoningEfforts: ["low", "high", "max"],
      },
    },
    deepseek: {
      "deepseek-flash": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 384_000,
        pricing: {
          cachedInput: 0.04,
          input: 2,
          offPeak: {
            cachedInput: 0.02,
            input: 1,
            output: 4,
          },
          output: 8,
          peakWindows: deepseekPeakWindows,
        },
        reasoningEfforts: ["low", "high", "max"],
      },
      "deepseek-v4-pro": {
        contextWindow: 1_000_000,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.3,
          input: 9,
          offPeak: {
            cachedInput: 0.15,
            input: 4.5,
            output: 13.5,
          },
          output: 27,
          peakWindows: deepseekPeakWindows,
        },
        reasoningEfforts: ["low", "high", "max"],
      },
    },
    kimi: {
      k3: {
        contextWindow: 1_048_576,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.3,
          input: 3,
          output: 15,
        },
      },
      "k3-256k": {
        contextWindow: 262_144,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.3,
          input: 3,
          output: 15,
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

  private normalizeKey(value: string): string {
    return value.trim().toLowerCase()
  }
}

export const builtinProviderModelRegistry = new BuiltinProviderModelRegistry()
