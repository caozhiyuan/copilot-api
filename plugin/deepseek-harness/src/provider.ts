import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import type { ProviderStreams, StreamOptions } from "@earendil-works/pi-ai"
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy"
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai"
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from "@deepseek-ai/dsh-llm-pi-ai"
import { LlmError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm"
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, ResolvedRetryPolicy, RetryPolicyConfig, StreamChunk } from "@deepseek-ai/dsh-llm"
import { gatewayFetch } from "./transport.ts"
import type { Settings } from "./config.ts"
import type { DiscoveredModel } from "./models.ts"
import type { CopilotModelCatalog } from "./catalog.ts"

/**
 * Build a public pi-ai Provider; both protocol converters are used unchanged.
 */
export function createProfile(config: Settings, baseURL: string, models: readonly DiscoveredModel[]): ResolvedPiAiProviderProfile {
  const api: ProviderStreams = config.protocol === "openai-responses" ? openAIResponsesApi() : anthropicMessagesApi()
  // Anthropic's SDK appends /v1/messages; OpenAI's appends /responses.
  const baseUrl = config.protocol === "anthropic-messages" ? baseURL.slice(0, -3) : baseURL
  const descriptors = models.map(model => ({ ...model, baseUrl }))
  const transport = <T extends StreamOptions>(options: T | undefined): T & Pick<StreamOptions, "fetch"> => {
    if (typeof options?.apiKey !== "string" || options.apiKey.length === 0) {
      throw new LlmError("copilot-api-provider: missing gateway credential", "MISSING_CREDENTIAL")
    }
    return { ...options, fetch: gatewayFetch(config, options.apiKey, options) }
  }
  return {
    provider: "copilot-api", displayName: "Copilot API", api: config.protocol, baseURL,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    maxRequestImageBytes: config.maxRequestImageBytes,
    requestImagePixelBudget: config.requestImagePixelBudget,
    requestImageMaxBytes: config.requestImageMaxBytes,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, "copilot-api-provider retryPolicy"),
    modelErrors: new Map(),
    // Discovery describes capacity; only an explicit override becomes a request default.
    configuredMaxTokens: new Map(Object.entries(config.modelOverrides).flatMap(([id, override]) =>
      override.maxTokens === undefined ? [] : [[id, override.maxTokens]])),
    piProvider: {
      id: "copilot-api", name: "Copilot API", baseUrl,
      auth: { apiKey: {
        name: "Copilot API",
        resolve: ({ credential }) => Promise.resolve({
          auth: credential?.key === undefined ? {} : { apiKey: credential.key }, source: "Copilot API",
        }),
      } },
      getModels: () => descriptors,
      stream: (model, context, options) => api.stream(model, context, transport(options)),
      streamSimple: (model, context, options) => api.streamSimple(model, context, transport(options)),
    },
  }
}

/** The only adapter extension is admission through the dynamically discovered catalog. */
export class CopilotApiAdapter extends PiAiAdapter {
  private readonly catalog: CopilotModelCatalog
  private readonly retryPolicy: ResolvedRetryPolicy

  constructor(catalog: CopilotModelCatalog, options: Omit<PiAiAdapterOptions, "profiles" | "auth">, retryPolicy?: RetryPolicyConfig) {
    super({
      ...options,
      profiles: () => catalog.profiles,
      // Harness supplies the key per attempt. This provider has no OAuth/ambient auth.
      auth: {
        credentials: new InMemoryCredentialStore(),
        authContext: { env: async () => undefined, fileExists: async () => false },
      },
    })
    this.catalog = catalog
    this.retryPolicy = resolveRetryPolicy(retryPolicy, "copilot-api-provider retryPolicy")
  }

  override providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: "Copilot API" } }
  override providerRetryPolicy(): ResolvedRetryPolicy { return this.retryPolicy }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    await this.catalog.ensure()
    return this.catalog.models?.length === 0 ? [] : super.listModels(provider)
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.catalog.ensure(signal)
    return super.resolveModel(provider, model, signal)
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    await this.catalog.ensure(signal)
    return super.prepareCall(provider, model, signal)
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.catalog.ensure(options.signal)
    yield* super.stream(options)
  }
}
