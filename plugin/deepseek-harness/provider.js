import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy"
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai"
import { LlmError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm"
import { gatewayFetch } from "./transport.js"

/**
 * Build a public pi-ai Provider; both protocol converters are used unchanged.
 * @returns {import("@deepseek-ai/dsh-llm-pi-ai").ResolvedPiAiProviderProfile}
 */
export function createProfile(config, baseURL, models) {
  const api = config.protocol === "openai-responses" ? openAIResponsesApi() : anthropicMessagesApi()
  // Anthropic's SDK appends /v1/messages; OpenAI's appends /responses.
  const baseUrl = config.protocol === "anthropic-messages" ? baseURL.slice(0, -3) : baseURL
  const descriptors = models.map(model => ({ ...model, baseUrl }))
  const transport = options => {
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
  constructor(catalog, options, retryPolicy) {
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

  providerInfo(provider) { return { id: provider, name: "Copilot API" } }
  providerRetryPolicy() { return this.retryPolicy }
  async listModels(provider) {
    await this.catalog.ensure()
    return this.catalog.models?.length === 0 ? [] : super.listModels(provider)
  }
  async resolveModel(provider, model, signal) {
    await this.catalog.ensure(signal)
    return super.resolveModel(provider, model, signal)
  }
  async prepareCall(provider, model, signal) {
    await this.catalog.ensure(signal)
    return super.prepareCall(provider, model, signal)
  }
  async *stream(options) {
    await this.catalog.ensure(options.signal)
    yield* super.stream(options)
  }
}
