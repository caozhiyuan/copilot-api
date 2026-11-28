import { events } from "fetch-event-stream"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import { parseProviderModelAlias } from "~/lib/catalog/provider-model"
import { isAntigravityUserAgent } from "~/lib/cli/antigravity"
import {
  getConfig,
  getMessageApiWebSearchModel,
  getProviderConfig,
  isResponsesApiWebSearchEnabled,
  resolveMappedModel,
  resolveProviderConfigForModel,
  type ModelConfig,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { HTTPError } from "~/lib/http/error"
import { recordGoogleFirstToken } from "~/lib/http/first-token"
import { stripInternalRequestHeaders } from "~/lib/http/internal-headers"
import { requestContext } from "~/lib/http/request-context"
import { setPluginRequestModel } from "~/lib/http/request-events"
import {
  forEachWithIdleKeepalive,
  writeRawSSEIfConnected,
  writeSSEIfConnected,
} from "~/lib/http/sse"
import { resolveSubagentMarker } from "~/lib/http/subagent"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import {
  resolveConfiguredProviderModelAlias,
  resolveProviderConfig,
} from "~/lib/providers/provider-resolver"
import { state } from "~/lib/state"
import {
  createProviderTokenUsageRecorder,
  normalizeAnthropicUsage,
} from "~/lib/token-usage"
import type { AnthropicResponse } from "~/lib/types/anthropic"
import type {
  GoogleGenerateContentRequest,
  GoogleGenerateContentResponse,
  GoogleModelsResponse,
  GoogleUsageMetadata,
} from "~/lib/types/google"
import { translateGoogleUsage } from "~/routes/messages/google-translation"
import { handleCompletionPayload } from "~/routes/messages/handler"
import {
  isWebSearchOnlyRequest,
  resolveWebSearchRoute,
} from "~/routes/messages/web-search/fulfill"
import {
  getAggregatedModels,
  type ClientModel,
} from "~/routes/models/model-discovery"
import { applyMissingExtraBody } from "~/routes/provider/utils"
import { forwardGoogleGenerateContent } from "~/services/providers/google"
import { resolveOpencodeMessagesSession } from "~/services/providers/provider-proxy"

import {
  applyAntigravityModelEffort,
  createAntigravityModelCatalog,
  mayUseAntigravityModelAlias,
} from "./antigravity-models"
import { stripAntigravitySignatures } from "./antigravity-signatures"
import { translateMessagesStreamToGoogle } from "./messages-stream-translation"
import {
  createGoogleErrorPayload,
  GoogleMessagesTranslationError,
  translateAnthropicResponseToGoogle,
  translateGoogleToMessages,
} from "./messages-translation"

const logger = createHandlerLogger("google-handler")

const GOOGLE_MODEL_ACTION_PATH_PATTERN = /^\/v1beta\/models\/(.+)$/u
const SESSION_UUID_PATTERN = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu
// Empty SSE frames keep reverse proxies alive without emitting SSE comments
// (rejected by google.golang.org/genai) or synthetic JSON data chunks.
const GOOGLE_SSE_KEEPALIVE_FRAME = "\n\n"
const DEFAULT_GOOGLE_SSE_KEEPALIVE_INTERVAL_MS = 15_000

export const googleHandlerDependencies = {
  forwardGoogleGenerateContent,
  getAggregatedModels,
  getMessageApiWebSearchModel,
  getProviderConfig,
  handleCompletionPayload,
  isResponsesApiWebSearchEnabled,
  resolveConfiguredProviderModelAlias,
  resolveProviderConfig,
  sseKeepaliveIntervalMs: DEFAULT_GOOGLE_SSE_KEEPALIVE_INTERVAL_MS,
}

export interface ParsedGoogleModelAction {
  model: string
  action: string
}

export function parseGoogleModelActionPath(
  url: string,
): ParsedGoogleModelAction | null {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    pathname = url.split("?")[0] ?? ""
  }

  const match = GOOGLE_MODEL_ACTION_PATH_PATTERN.exec(pathname)
  if (!match) return null

  const suffix = match[1]
  const colonIndex = suffix.lastIndexOf(":")
  if (colonIndex <= 0 || colonIndex === suffix.length - 1) {
    return null
  }

  const rawModel = suffix.slice(0, colonIndex)
  const action = suffix.slice(colonIndex + 1)

  let decodedModel: string
  try {
    decodedModel = decodeURIComponent(rawModel)
  } catch {
    throw new GoogleMessagesTranslationError(
      "Malformed URL-encoded model identifier",
      400,
    )
  }

  const normalizedModel = decodedModel.replace(/^models\//u, "").trim()
  if (!normalizedModel) {
    throw new GoogleMessagesTranslationError(
      "Model identifier must not be empty",
      400,
    )
  }

  return { model: normalizedModel, action }
}

function toGoogleModelEntry(
  model: ClientModel,
): NonNullable<GoogleModelsResponse["models"]>[number] {
  const displayName =
    typeof model.display_name === "string" && model.display_name.length > 0 ?
      model.display_name
    : model.id
  const inputTokenLimit =
    typeof model.input_limit === "number" ? model.input_limit
    : typeof model.context_window === "number" ? model.context_window
    : undefined
  const outputTokenLimit =
    typeof model.max_output_tokens === "number" ?
      model.max_output_tokens
    : undefined

  return {
    name: `models/${model.id}`,
    displayName,
    ...(inputTokenLimit !== undefined ? { inputTokenLimit } : {}),
    ...(outputTokenLimit !== undefined ? { outputTokenLimit } : {}),
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
  }
}

type ModelAliases = Pick<
  ReturnType<typeof createAntigravityModelCatalog>,
  "mediaAliases" | "variants"
>

let modelAliasCatalog:
  | {
      config: ReturnType<typeof getConfig>
      copilotModels: typeof state.models
      aliases: ModelAliases
    }
  | undefined

async function refreshModelAliasCatalog(c: Context) {
  const config = getConfig()
  const copilotModels = state.models
  const models = await googleHandlerDependencies.getAggregatedModels(
    stripInternalRequestHeaders(c.req.raw.headers),
    { includeImageModels: false },
  )
  const { entries, ...aliases } = createAntigravityModelCatalog(
    models,
    googleHandlerDependencies.getProviderConfig,
  )
  modelAliasCatalog = { config, copilotModels, aliases }
  return { entries, ...aliases }
}

export async function handleGoogleModelsList(c: Context): Promise<Response> {
  const { entries } = await refreshModelAliasCatalog(c)
  const response: GoogleModelsResponse = {
    models: entries.map(toGoogleModelEntry),
  }
  return c.json(response)
}

async function getModelAliases(c: Context): Promise<ModelAliases> {
  const catalog = modelAliasCatalog
  if (
    catalog?.config === getConfig()
    && catalog.copilotModels === state.models
  ) {
    return catalog.aliases
  }
  return refreshModelAliasCatalog(c)
}

function readSessionLabel(value: unknown): string | undefined {
  const id = typeof value === "string" ? value.trim() : ""
  return SESSION_UUID_PATTERN.test(id) ? id : undefined
}

function applyAntigravitySessionLabels(
  labels: GoogleGenerateContentRequest["labels"],
): void {
  const context = requestContext.getStore()
  if (!labels || !context || !isAntigravityUserAgent(context.userAgent)) return
  if (context.sessionAffinity || context.rootSessionId) return

  context.sessionAffinity = readSessionLabel(labels.cascade_id)
  context.rootSessionId = readSessionLabel(labels.root_cascade_id)
  context.parentSessionId ??= readSessionLabel(labels.parent_cascade_id)
  context.subagent = resolveSubagentMarker(
    context.rootSessionId,
    context.sessionAffinity,
  )
  if (context.sessionAffinity) {
    context.pluginRequest?.setSessionId(context.sessionAffinity)
  }
}

export async function handleGoogleGenerateContent(
  c: Context,
): Promise<Response> {
  try {
    const parsedPath = parseGoogleModelActionPath(c.req.url)
    if (!parsedPath) {
      return c.json(
        createGoogleErrorPayload(
          404,
          "Expected path ending with ':generateContent' or ':streamGenerateContent'",
        ),
        404,
      )
    }

    if (
      parsedPath.action !== "generateContent"
      && parsedPath.action !== "streamGenerateContent"
    ) {
      return c.json(
        createGoogleErrorPayload(
          400,
          `Unsupported Google Gemini action '${parsedPath.action}'. Supported actions are 'generateContent' and 'streamGenerateContent'.`,
        ),
        400,
      )
    }

    let requestBody: GoogleGenerateContentRequest
    try {
      requestBody = await c.req.json<GoogleGenerateContentRequest>()
    } catch {
      return c.json(
        createGoogleErrorPayload(400, "Invalid JSON request body"),
        400,
      )
    }

    const stream = parsedPath.action === "streamGenerateContent"
    const useSSE = c.req.query("alt")?.toLowerCase() === "sse"
    applyAntigravitySessionLabels(requestBody?.labels)
    setPluginRequestModel(parsedPath.model)

    let mappedModel = resolveMappedModel(parsedPath.model)
    if (
      mappedModel === parsedPath.model
      && mayUseAntigravityModelAlias(parsedPath.model)
    ) {
      const { mediaAliases, variants } = await getModelAliases(c)
      const model = mediaAliases.get(parsedPath.model) ?? parsedPath.model
      mappedModel = resolveMappedModel(model)
      const variant = mappedModel === model ? variants.get(model) : undefined
      if (variant) {
        mappedModel = resolveMappedModel(variant.model)
        applyAntigravityModelEffort(requestBody, variant.effort)
      }
    }
    debugJson(logger, "Google generateContent request:", {
      action: parsedPath.action,
      mappedModel,
      model: parsedPath.model,
      useSSE,
      requestBody,
    })

    const providerAlias =
      await googleHandlerDependencies.resolveConfiguredProviderModelAlias(
        mappedModel,
        googleHandlerDependencies.resolveProviderConfig,
      )
    if (providerAlias) {
      const configuredProvider =
        await googleHandlerDependencies.resolveProviderConfig(
          providerAlias.provider,
        )
      const providerConfig =
        configuredProvider
        && resolveProviderConfigForModel(
          configuredProvider,
          providerAlias.model,
        )
      if (providerConfig?.type === "google") {
        return await handleNativeGoogleProviderPassthrough(c, {
          model: providerAlias.model,
          payload: requestBody,
          providerConfig,
          stream,
          useSSE,
        })
      }
    }

    const messagesPayload = translateGoogleToMessages(requestBody, {
      model: mappedModel,
      stream,
    })
    debugJson(logger, "Translated Messages payload:", messagesPayload)

    if (isWebSearchOnlyRequest(messagesPayload)) {
      const webSearchModel =
        googleHandlerDependencies.getMessageApiWebSearchModel()
      const responsesWebSearchEnabled =
        googleHandlerDependencies.isResponsesApiWebSearchEnabled()
      const webSearchRoute = await resolveWebSearchRoute(messagesPayload, {
        webSearchModel,
        responsesWebSearchEnabled,
        resolveProviderConfig: googleHandlerDependencies.resolveProviderConfig,
      })

      if (webSearchRoute.kind === "strip") {
        return c.json(
          createGoogleErrorPayload(
            400,
            buildGoogleWebSearchUnavailableMessage(webSearchModel),
          ),
          400,
        )
      }

      if (webSearchRoute.kind === "provider") {
        const configuredWebSearchProvider =
          await googleHandlerDependencies.resolveProviderConfig(
            webSearchRoute.alias.provider,
          )
        const webSearchProviderConfig =
          configuredWebSearchProvider
          && resolveProviderConfigForModel(
            configuredWebSearchProvider,
            webSearchRoute.alias.model,
          )
        if (webSearchProviderConfig?.type === "google") {
          return await handleNativeGoogleProviderPassthrough(c, {
            model: webSearchRoute.alias.model,
            payload: requestBody,
            providerConfig: webSearchProviderConfig,
            stream,
            useSSE,
          })
        }
        if (webSearchProviderConfig?.type === "openai-compatible") {
          return c.json(
            createGoogleErrorPayload(
              400,
              `Google Search is not supported by 'messageApiWebSearchModel' ('${webSearchModel}') because provider '${webSearchRoute.alias.provider}' uses type 'openai-compatible'.`,
            ),
            400,
          )
        }
      }
    }

    const messagesResponse =
      await googleHandlerDependencies.handleCompletionPayload(
        c,
        messagesPayload,
        {
          forwardStructuredOutput: true,
          skipClaudeAutoModel: true,
          skipModelMapping: true,
          usageEndpoint: "generate_content",
        },
      )

    if (!messagesResponse.ok) {
      return messagesResponse
    }

    const contentType = messagesResponse.headers.get("content-type") ?? ""
    if (contentType.includes("text/event-stream")) {
      if (!stream) {
        clearStreamSSEHeaders(c)
        await messagesResponse.body?.cancel()
        throw new GoogleMessagesTranslationError(
          "Messages API returned a stream for a non-streaming generateContent request",
          502,
        )
      }
      if (useSSE) {
        return streamTranslatedGoogleSSE(c, messagesResponse, parsedPath.model)
      }
      clearStreamSSEHeaders(c)
      return await collectTranslatedGoogleJsonArray(
        c,
        messagesResponse,
        parsedPath.model,
      )
    }

    const body: unknown = await messagesResponse.json()
    if (!isAnthropicResponse(body)) {
      throw new GoogleMessagesTranslationError(
        "Messages API returned an invalid response body",
        502,
      )
    }

    const googleResponse = translateAnthropicResponseToGoogle(
      body,
      parsedPath.model,
      {
        preserveAntigravityReasoning: isAntigravityUserAgent(
          c.req.header("user-agent"),
        ),
      },
    )
    debugJson(logger, "Translated Google response:", googleResponse)

    if (!stream) {
      return c.json(googleResponse)
    }
    if (useSSE) {
      return streamSSE(c, async (sseStream) => {
        await writeSSEIfConnected(sseStream, {
          data: JSON.stringify(googleResponse),
        })
      })
    }
    return c.json([googleResponse])
  } catch (error) {
    if (error instanceof GoogleMessagesTranslationError) {
      return c.json(
        createGoogleErrorPayload(error.status, error.message),
        error.status,
      )
    }
    throw error
  }
}

function buildGoogleWebSearchUnavailableMessage(
  webSearchModel: string | undefined,
): string {
  if (!webSearchModel) {
    return "Google Search is not configured on this gateway. Configure 'messageApiWebSearchModel' (and enable 'useResponsesApiWebSearch' for Copilot models) or route the model to a Google provider."
  }
  if (parseProviderModelAlias(webSearchModel)) {
    return `Google Search is unavailable because 'messageApiWebSearchModel' ('${webSearchModel}') does not match an enabled provider.`
  }
  return "Google Search is disabled because 'useResponsesApiWebSearch' is off. Enable 'useResponsesApiWebSearch' or configure 'messageApiWebSearchModel' with a web-search-capable provider."
}

function clearStreamSSEHeaders(c: Context): void {
  c.header("Transfer-Encoding", undefined)
  c.header("Cache-Control", undefined)
  c.header("Connection", undefined)
}

function createAbortableResponse(
  response: Response,
  signal: AbortSignal,
): Response {
  return new Response(
    response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
      signal,
    }),
    { headers: response.headers },
  )
}

function createAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error("The operation was aborted")
  error.name = "AbortError"
  return error
}

function resolveGoogleErrorStatus(
  code: number | undefined,
): ContentfulStatusCode {
  return (
    (
      typeof code === "number"
      && Number.isInteger(code)
      && code >= 400
      && code <= 599
    ) ?
      code
    : 502) as ContentfulStatusCode
}

function markProtocolFailed(): void {
  const timing = requestContext.getStore()?.requestTiming
  if (timing) timing.protocolFailed = true
}

function applyGoogleModelConfigDefaults(
  payload: GoogleGenerateContentRequest,
  modelConfig: ModelConfig | undefined,
): GoogleGenerateContentRequest {
  if (
    !modelConfig
    || typeof payload !== "object"
    || payload === null
    || Array.isArray(payload)
  ) {
    return payload
  }

  const extraGenerationConfig = modelConfig.extraBody?.generationConfig
  const hasExtraGenerationConfig =
    Boolean(extraGenerationConfig)
    && typeof extraGenerationConfig === "object"
    && !Array.isArray(extraGenerationConfig)
  const hasSamplingDefaults =
    modelConfig.temperature !== undefined
    || modelConfig.topP !== undefined
    || modelConfig.topK !== undefined

  if (!hasSamplingDefaults && !modelConfig.extraBody) {
    return payload
  }

  const forwarded: GoogleGenerateContentRequest = { ...payload }
  if (hasSamplingDefaults || hasExtraGenerationConfig) {
    const generationConfig: Record<string, unknown> = {
      ...forwarded.generationConfig,
    }
    if (
      generationConfig.temperature === undefined
      && modelConfig.temperature !== undefined
    ) {
      generationConfig.temperature = modelConfig.temperature
    }
    if (generationConfig.topP === undefined && modelConfig.topP !== undefined) {
      generationConfig.topP = modelConfig.topP
    }
    if (generationConfig.topK === undefined && modelConfig.topK !== undefined) {
      generationConfig.topK = modelConfig.topK
    }
    if (hasExtraGenerationConfig) {
      for (const [key, value] of Object.entries(
        extraGenerationConfig as Record<string, unknown>,
      )) {
        if (generationConfig[key] === undefined) {
          generationConfig[key] = value
        }
      }
    }
    forwarded.generationConfig = generationConfig
  }

  applyMissingExtraBody(forwarded as unknown as Record<string, unknown>, {
    extraBody: modelConfig.extraBody,
  })
  return forwarded
}

async function* readNativeGoogleStream(
  upstream: Response,
  signal: AbortSignal,
): AsyncGenerator<GoogleGenerateContentResponse> {
  const response = createAbortableResponse(upstream, signal)
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    for await (const event of events(response, signal)) {
      if (!event.data || event.data === "[DONE]") continue
      yield JSON.parse(event.data) as GoogleGenerateContentResponse
    }
    return
  }

  const body = (await response.json()) as
    | GoogleGenerateContentResponse
    | Array<GoogleGenerateContentResponse>
  yield* Array.isArray(body) ? body : [body]
}

async function handleNativeGoogleProviderPassthrough(
  c: Context,
  options: {
    model: string
    payload: GoogleGenerateContentRequest
    providerConfig: ResolvedProviderConfig
    stream: boolean
    useSSE: boolean
  },
): Promise<Response> {
  const { model, payload, providerConfig, stream, useSSE } = options
  const modelConfig = providerConfig.models?.[model]
  const forwardedPayload = applyGoogleModelConfigDefaults(
    stripAntigravitySignatures(payload),
    modelConfig,
  )
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, c.req.raw.signal])

  const upstream = await googleHandlerDependencies.forwardGoogleGenerateContent(
    providerConfig,
    model,
    forwardedPayload,
    c.req.raw.headers,
    {
      stream,
      clientSignal: signal,
      sessionId: resolveOpencodeMessagesSession(),
    },
  )

  if (!upstream.ok) {
    throw new HTTPError("Failed to create Google response", upstream)
  }

  const recordUsage = createProviderTokenUsageRecorder({
    endpoint: "generate_content",
    model,
    pricing: modelConfig?.pricing,
    pricingCurrency: providerConfig.pricingCurrency,
    providerName: providerConfig.name,
  })

  if (!stream) {
    const response = (await upstream.json()) as GoogleGenerateContentResponse
    recordUsage(
      normalizeAnthropicUsage(translateGoogleUsage(response.usageMetadata)),
    )
    return c.json(response)
  }

  let usageMetadata: GoogleUsageMetadata = {}
  const recordStreamChunk = (chunk: GoogleGenerateContentResponse): void => {
    recordGoogleFirstToken(chunk)
    if (chunk.usageMetadata) {
      usageMetadata = { ...usageMetadata, ...chunk.usageMetadata }
    }
  }

  if (!useSSE) {
    const chunks: Array<GoogleGenerateContentResponse> = []
    try {
      for await (const chunk of readNativeGoogleStream(upstream, signal)) {
        recordStreamChunk(chunk)
        chunks.push(chunk)
      }
      if (signal.aborted) {
        throw createAbortError(signal.reason)
      }
    } finally {
      controller.abort()
      recordUsage(normalizeAnthropicUsage(translateGoogleUsage(usageMetadata)))
    }

    const errorChunk = chunks.find((chunk) => chunk.error)
    if (errorChunk?.error) {
      markProtocolFailed()
      return c.json(errorChunk, resolveGoogleErrorStatus(errorChunk.error.code))
    }

    return c.json(chunks)
  }

  return streamSSE(c, async (sseStream) => {
    sseStream.onAbort(() => controller.abort())
    try {
      await forEachWithIdleKeepalive(readNativeGoogleStream(upstream, signal), {
        intervalMs: googleHandlerDependencies.sseKeepaliveIntervalMs,
        signal,
        onChunk: async (chunk) => {
          recordStreamChunk(chunk)
          return await writeSSEIfConnected(
            sseStream,
            { data: JSON.stringify(chunk) },
            chunk.error ? "error" : undefined,
          )
        },
        onKeepalive: () =>
          writeRawSSEIfConnected(sseStream, GOOGLE_SSE_KEEPALIVE_FRAME),
      })
    } catch (error) {
      if (!signal.aborted) {
        logger.warn("google.passthrough.stream_interrupted", error)
        const errorPayload = createGoogleErrorPayload(
          502,
          error instanceof Error ? error.message : "Google stream interrupted",
        )
        await writeSSEIfConnected(
          sseStream,
          { data: JSON.stringify(errorPayload) },
          "error",
        )
      }
    } finally {
      controller.abort()
      recordUsage(normalizeAnthropicUsage(translateGoogleUsage(usageMetadata)))
    }
  })
}

function streamTranslatedGoogleSSE(
  c: Context,
  messagesResponse: Response,
  fallbackModel: string,
): Response {
  return streamSSE(c, async (sseStream) => {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, c.req.raw.signal])
    sseStream.onAbort(() => controller.abort())
    try {
      const response = createAbortableResponse(messagesResponse, signal)
      await forEachWithIdleKeepalive(
        translateMessagesStreamToGoogle(events(response, signal), {
          fallbackModel,
          signal,
          preserveAntigravityReasoning: isAntigravityUserAgent(
            c.req.header("user-agent"),
          ),
        }),
        {
          intervalMs: googleHandlerDependencies.sseKeepaliveIntervalMs,
          signal,
          onChunk: async (chunk) => {
            debugJson(logger, "Translated Google stream chunk:", chunk)
            return await writeSSEIfConnected(
              sseStream,
              { data: JSON.stringify(chunk) },
              chunk.error ? "error" : undefined,
            )
          },
          onKeepalive: () =>
            writeRawSSEIfConnected(sseStream, GOOGLE_SSE_KEEPALIVE_FRAME),
        },
      )
    } finally {
      controller.abort()
    }
  })
}

async function collectTranslatedGoogleJsonArray(
  c: Context,
  messagesResponse: Response,
  fallbackModel: string,
): Promise<Response> {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, c.req.raw.signal])
  const chunks: Array<GoogleGenerateContentResponse> = []
  try {
    const response = createAbortableResponse(messagesResponse, signal)
    for await (const chunk of translateMessagesStreamToGoogle(
      events(response, signal),
      {
        fallbackModel,
        signal,
        preserveAntigravityReasoning: isAntigravityUserAgent(
          c.req.header("user-agent"),
        ),
      },
    )) {
      chunks.push(chunk)
    }
    if (c.req.raw.signal.aborted) {
      throw createAbortError(c.req.raw.signal.reason)
    }
  } finally {
    controller.abort()
  }

  const errorChunk = chunks.find((chunk) => chunk.error)
  if (errorChunk?.error) {
    markProtocolFailed()
    return c.json(errorChunk, resolveGoogleErrorStatus(errorChunk.error.code))
  }

  return c.json(chunks)
}

function isAnthropicResponse(value: unknown): value is AnthropicResponse {
  return (
    typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === "message"
    && "content" in value
    && Array.isArray(value.content)
  )
}
