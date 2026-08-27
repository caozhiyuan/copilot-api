import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { logCodexRateLimitsEvent } from "~/lib/codex-rate-limit"
import {
  type ModelConfig,
  type ProviderType,
  resolveEffectiveProviderType,
} from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { requestContext } from "~/lib/request-context"
import {
  createProviderTokenUsageRecorder,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { isResponsesStream } from "~/lib/utils"
import { isCodexUserAgent } from "~/routes/models/codex-models"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
} from "~/routes/responses/utils"
import { handleResponsesViaMessages } from "~/routes/responses/messages-handler"
import { normalizeProviderResponsesReasoningEffort } from "~/routes/provider/utils"

import type {
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
  ResponsesStream,
} from "~/lib/types/responses"
import { forwardCodexResponses } from "~/services/codex/create-responses"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import { createResponsesSafeStream } from "~/services/responses-websocket-helpers"
import { createResponsesHttpEventStream } from "~/services/responses-http"
import {
  createProviderProxyResponse,
  forwardProviderResponses,
} from "~/services/providers/provider-proxy"
import type { ContentfulStatusCode } from "hono/utils/http-status"

const logger = createHandlerLogger("provider-responses-handler")

export const providerResponsesHandlerDependencies = {
  resolveProviderConfig,
}

export async function handleProviderResponsesForProvider(
  c: Context,
  options: {
    payload: ResponsesPayload
    provider: string
    publicModel?: string
  },
): Promise<Response> {
  const { payload, provider } = options

  debugJson(logger, "Responses request payload:", {
    payload,
    provider,
  })

  const providerConfig =
    await providerResponsesHandlerDependencies.resolveProviderConfig(provider)
  if (!providerConfig) {
    return c.json(
      {
        error: {
          message: `Provider '${provider}' does not support the /v1/responses endpoint`,
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  const effectiveType = resolveEffectiveProviderType(
    providerConfig,
    payload.model,
  )
  const normalizedReasoningEffort = normalizeProviderResponsesReasoningEffort(
    payload,
    providerConfig,
  )
  if (normalizedReasoningEffort) {
    logger.debug(
      `Normalized reasoning effort from ${normalizedReasoningEffort.from} to ${normalizedReasoningEffort.to} based on the provider model configuration`,
    )
  }

  if (shouldFallbackToMessages(c, payload.model, effectiveType)) {
    return await handleResponsesViaMessages(c, {
      payload,
      publicModel: options.publicModel ?? payload.model,
      targetModel: `${provider}/${payload.model}`,
    })
  }

  if (effectiveType !== "openai-responses") {
    return c.json(
      {
        error: {
          message: `Provider '${provider}' does not support the /v1/responses endpoint`,
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  const model =
    providerConfig.name === "codex" ?
      getCodexModels().data.find((model) => model.id === payload.model)
    : undefined

  // Smaller than the client compaction threshold, use server-side compaction to maintain cache hit rate.
  const shouldCompactInput = applyResponsesApiContextManagement(
    payload,
    model?.capabilities.limits.max_prompt_tokens,
    {
      compactThresholdRatio: 0.8,
      source: "responses",
    },
  )
  if (shouldCompactInput) {
    compactInputByLatestCompaction(payload)
  }

  debugJson(logger, "Translated Responses request payload:", {
    contextManagement: payload.context_management,
    provider,
  })

  const modelConfig = providerConfig.models?.[payload.model]

  if (providerConfig.name === "codex") {
    const upstreamResponse = await forwardCodexResponses(
      payload,
      c.req.raw.headers,
      providerConfig.baseUrl,
      { signal: c.req.raw.signal },
    )
    const recordUsage = createProviderResponsesUsageRecorder(
      payload,
      provider,
      modelConfig,
      providerConfig.pricingCurrency,
    )

    if (payload.stream && isResponsesStream(upstreamResponse)) {
      return streamProviderResponses(c, upstreamResponse, {
        normalizeCodex: true,
        provider,
        recordUsage,
      })
    }

    const responseBody = upstreamResponse as ResponsesResult
    recordUsage(normalizeResponsesUsage(responseBody.usage))
    return c.json(responseBody)
  }

  const upstreamResponse = await forwardProviderResponses(
    providerConfig,
    payload,
    c.req.raw.headers,
    { signal: c.req.raw.signal },
  )

  if (!upstreamResponse.ok) {
    throw new HTTPError(
      `Failed to create ${provider} responses`,
      upstreamResponse,
    )
  }

  const recordUsage = createProviderResponsesUsageRecorder(
    payload,
    provider,
    modelConfig,
    providerConfig.pricingCurrency,
  )

  if (payload.stream) {
    return streamProviderResponses(
      c,
      getResponsesEvents(upstreamResponse, c.req.raw.signal),
      {
        normalizeCodex: false,
        provider,
        recordUsage,
      },
    )
  }

  const responseBody = (await upstreamResponse
    .clone()
    .json()) as ResponsesResult
  recordUsage(normalizeResponsesUsage(responseBody.usage))

  return createProviderProxyResponse(upstreamResponse)
}

const shouldFallbackToMessages = (
  c: Context,
  modelId: string,
  effectiveType: ProviderType,
): boolean => {
  if (effectiveType === "anthropic" || effectiveType === "openai-compatible") {
    return true
  }

  if (isCodexUserAgent(c.req.header("user-agent"))) {
    return !(modelId.startsWith("gpt") || modelId.startsWith("codex"))
  }

  return false
}

const createProviderResponsesUsageRecorder = (
  payload: ResponsesPayload,
  provider: string,
  modelConfig: ModelConfig | undefined,
  pricingCurrency: string | undefined,
): ((usage: UsageTokens) => void) => {
  const sessionAffinity =
    requestContext.getStore()?.sessionAffinity?.trim() || null

  return createProviderTokenUsageRecorder({
    endpoint: "responses",
    model: payload.model,
    pricing: modelConfig?.pricing,
    pricingCurrency,
    providerName: provider,
    sessionId: sessionAffinity ?? "",
  })
}

const streamProviderResponses = async (
  c: Context,
  upstreamResponse: ResponsesStream,
  options: {
    normalizeCodex: boolean
    provider: string
    recordUsage: (usage: UsageTokens) => void
  },
): Promise<Response> => {
  const iterator = upstreamResponse[Symbol.asyncIterator]()
  const firstResult = await iterator.next()
  if (firstResult.done) {
    await iterator.return?.()
    throw new HTTPError(
      `Empty stream from ${options.provider} responses`,
      new Response("", { status: 502 }),
    )
  }

  const firstChunk = firstResult.value
  if (firstChunk.data && firstChunk.data !== "[DONE]") {
    const event = parseProviderResponsesStreamEvent(firstChunk.data, {
      normalizeCodex: false,
      provider: options.provider,
    })
    if (event?.type === "error") {
      const errorEvent = event
      const statusCode = errorEvent.status_code ?? 500
      await iterator.return?.()
      return c.json(
        {
          error: {
            message: errorEvent.message,
            ...errorEvent.error,
          },
        },
        statusCode as ContentfulStatusCode,
        errorEvent.headers ?? undefined,
      )
    }
  }

  return streamSSE(
    c,
    async (stream) => {
      let usage: UsageTokens = {}

      const writeChunk = async (chunk: typeof firstChunk) => {
        debugJson(logger, "Responses stream chunk:", chunk)
        let responseChunk = chunk
        let event: ResponseStreamEvent | null = null

        if (chunk.data && chunk.data !== "[DONE]") {
          event = parseProviderResponsesStreamEvent(chunk.data, {
            normalizeCodex: options.normalizeCodex,
            provider: options.provider,
          })
          if (event && options.normalizeCodex) {
            responseChunk = {
              ...chunk,
              data: JSON.stringify(event),
              event: event.type,
            }
          }
        }

        if (event) {
          const nextUsage = getResponsesStreamEventUsage(event)
          if (nextUsage) {
            usage = nextUsage
          }
        }

        await stream.writeSSE({
          data: responseChunk.data ?? "",
          event: responseChunk.event,
        })
      }

      try {
        await writeChunk(firstChunk)

        for await (const chunk of {
          [Symbol.asyncIterator]: () => iterator,
        }) {
          await writeChunk(chunk)
        }
      } finally {
        await iterator.return?.()
        options.recordUsage(usage)
      }
    },
    async (error, stream) => {
      // ponytail: upstream drop mid-stream, surface it instead of a silent disconnect.
      logger.error("provider.responses.stream_error", { error })
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          error: { message: error.message, type: "stream_error" },
        }),
      })
    },
  )
}

const parseProviderResponsesStreamEvent = (
  data: string,
  options: {
    normalizeCodex: boolean
    provider: string
  },
): ResponseStreamEvent | null => {
  try {
    const parsed = JSON.parse(data) as ResponseStreamEvent
    if (options.normalizeCodex) {
      logCodexRateLimitsEvent(parsed)
    }
    return parsed
  } catch (error) {
    logger.error("provider.responses.parse_chunk_error", {
      provider: options.provider,
      data,
      error,
    })
    return null
  }
}

const getResponsesStreamEventUsage = (
  event: ResponseStreamEvent,
): UsageTokens | null => {
  if (
    event.type === "response.completed"
    || event.type === "response.failed"
    || event.type === "response.incomplete"
  ) {
    return normalizeResponsesUsage(event.response.usage)
  }

  return null
}

const getResponsesEvents = (
  response: Response,
  signal?: AbortSignal,
): ResponsesStream =>
  createResponsesSafeStream(createResponsesHttpEventStream(response, signal), {
    signal,
  })
