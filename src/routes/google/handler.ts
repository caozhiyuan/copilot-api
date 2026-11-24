import { events } from "fetch-event-stream"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import {
  resolveMappedModel,
  resolveProviderConfigForModel,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { HTTPError } from "~/lib/http/error"
import { recordGoogleFirstToken } from "~/lib/http/first-token"
import { stripInternalRequestHeaders } from "~/lib/http/internal-headers"
import { setPluginRequestModel } from "~/lib/http/request-events"
import { writeSSEIfConnected } from "~/lib/http/sse"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import {
  resolveConfiguredProviderModelAlias,
  resolveProviderConfig,
} from "~/lib/providers/provider-resolver"
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
  getAggregatedModels,
  type ClientModel,
} from "~/routes/models/model-discovery"
import { forwardGoogleGenerateContent } from "~/services/providers/google"
import { resolveOpencodeMessagesSession } from "~/services/providers/provider-proxy"

import { translateMessagesStreamToGoogle } from "./messages-stream-translation"
import {
  createGoogleErrorPayload,
  GoogleMessagesTranslationError,
  translateAnthropicResponseToGoogle,
  translateGoogleToMessages,
} from "./messages-translation"

const logger = createHandlerLogger("google-handler")

const GOOGLE_MODEL_ACTION_PATH_PATTERN =
  /^(?:\/v1beta|\/v1beta1\/projects\/[^/]+\/locations\/[^/]+\/publishers\/google)\/models\/(.+)$/u

export const googleHandlerDependencies = {
  forwardGoogleGenerateContent,
  getAggregatedModels,
  handleCompletionPayload,
  resolveConfiguredProviderModelAlias,
  resolveProviderConfig,
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

export async function handleGoogleModelsList(c: Context): Promise<Response> {
  const models = await googleHandlerDependencies.getAggregatedModels(
    stripInternalRequestHeaders(c.req.raw.headers),
    { includeImageModels: false },
  )
  const response: GoogleModelsResponse = {
    models: models.map(toGoogleModelEntry),
  }
  return c.json(response)
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
    setPluginRequestModel(parsedPath.model)

    const mappedModel = resolveMappedModel(parsedPath.model)
    debugJson(logger, "Google generateContent request:", {
      action: parsedPath.action,
      mappedModel,
      model: parsedPath.model,
      useSSE,
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

    const messagesResponse =
      await googleHandlerDependencies.handleCompletionPayload(
        c,
        messagesPayload,
        {
          skipClaudeAutoModel: true,
          skipModelMapping: true,
          skipWebSearch: true,
          usageEndpoint: "generate_content",
        },
      )

    if (!messagesResponse.ok) {
      return messagesResponse
    }

    const contentType = messagesResponse.headers.get("content-type") ?? ""
    if (contentType.includes("text/event-stream")) {
      if (!stream) {
        throw new GoogleMessagesTranslationError(
          "Messages API returned a stream for a non-streaming generateContent request",
          502,
        )
      }
      if (useSSE) {
        return streamTranslatedGoogleSSE(c, messagesResponse, parsedPath.model)
      }
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
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, c.req.raw.signal])

  const upstream = await googleHandlerDependencies.forwardGoogleGenerateContent(
    providerConfig,
    model,
    payload,
    c.req.raw.headers,
    {
      stream,
      clientSignal: signal,
      sessionId: resolveOpencodeMessagesSession(),
    },
  )

  if (!upstream.ok) {
    controller.abort()
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

  const isUpstreamSSE =
    upstream.headers.get("content-type")?.includes("text/event-stream") ?? false

  if (!useSSE) {
    const chunks: Array<GoogleGenerateContentResponse> = []
    let usageMetadata: GoogleUsageMetadata = {}
    try {
      if (isUpstreamSSE) {
        for await (const event of events(upstream, signal)) {
          if (!event.data || event.data === "[DONE]") continue
          const parsed = JSON.parse(event.data) as GoogleGenerateContentResponse
          recordGoogleFirstToken(parsed)
          if (parsed.usageMetadata) {
            usageMetadata = { ...usageMetadata, ...parsed.usageMetadata }
          }
          chunks.push(parsed)
        }
      } else {
        const parsed = (await upstream.json()) as
          | GoogleGenerateContentResponse
          | Array<GoogleGenerateContentResponse>
        const items = Array.isArray(parsed) ? parsed : [parsed]
        for (const item of items) {
          recordGoogleFirstToken(item)
          if (item.usageMetadata) {
            usageMetadata = { ...usageMetadata, ...item.usageMetadata }
          }
          chunks.push(item)
        }
      }
    } finally {
      controller.abort()
      recordUsage(normalizeAnthropicUsage(translateGoogleUsage(usageMetadata)))
    }
    return c.json(chunks)
  }

  return streamSSE(c, async (sseStream) => {
    let usageMetadata: GoogleUsageMetadata = {}
    sseStream.onAbort(() => controller.abort())
    try {
      const response = new Response(
        upstream.body?.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>(),
          { signal },
        ),
        { headers: upstream.headers },
      )
      if (isUpstreamSSE) {
        for await (const event of events(response, signal)) {
          if (!event.data || event.data === "[DONE]") continue
          const parsed = JSON.parse(event.data) as GoogleGenerateContentResponse
          recordGoogleFirstToken(parsed)
          if (parsed.usageMetadata) {
            usageMetadata = { ...usageMetadata, ...parsed.usageMetadata }
          }
          await writeSSEIfConnected(
            sseStream,
            { data: JSON.stringify(parsed) },
            parsed.error ? "error" : undefined,
          )
        }
      } else {
        const parsed = (await response.json()) as
          | GoogleGenerateContentResponse
          | Array<GoogleGenerateContentResponse>
        const items = Array.isArray(parsed) ? parsed : [parsed]
        for (const item of items) {
          recordGoogleFirstToken(item)
          if (item.usageMetadata) {
            usageMetadata = { ...usageMetadata, ...item.usageMetadata }
          }
          await writeSSEIfConnected(
            sseStream,
            { data: JSON.stringify(item) },
            item.error ? "error" : undefined,
          )
        }
      }
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
      for await (const chunk of translateMessagesStreamToGoogle(
        events(messagesResponse, signal),
        { fallbackModel },
      )) {
        debugJson(logger, "Translated Google stream chunk:", chunk)
        await writeSSEIfConnected(
          sseStream,
          { data: JSON.stringify(chunk) },
          chunk.error ? "error" : undefined,
        )
      }
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
  const chunks: Array<GoogleGenerateContentResponse> = []
  for await (const chunk of translateMessagesStreamToGoogle(
    events(messagesResponse, c.req.raw.signal),
    { fallbackModel },
  )) {
    chunks.push(chunk)
  }

  if (chunks.length === 1 && chunks[0]?.error) {
    const status = (chunks[0].error.code ?? 502) as ContentfulStatusCode
    return c.json(chunks[0], status)
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
