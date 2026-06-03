import type { Context } from "hono"

import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import { logCodexRateLimitsEvent } from "~/lib/codex-rate-limit"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { applyModelOverride } from "~/lib/models"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { requestContext } from "~/lib/request-context"
import {
  createProviderTokenUsageRecorder,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
} from "~/routes/responses/utils"
import type {
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
  ResponsesStream,
} from "~/services/copilot/create-responses"
import { forwardCodexResponses } from "~/services/codex/create-responses"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import {
  createProviderProxyResponse,
  forwardProviderResponses,
} from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("provider-responses-handler")

export async function handleProviderResponsesForProvider(
  c: Context,
  options: {
    payload: ResponsesPayload
    provider: string
  },
): Promise<Response> {
  const { payload, provider } = options
  debugJson(logger, "Responses request payload:", {
    payload,
    provider,
  })
  const providerConfig = await resolveProviderConfig(provider)
  if (providerConfig?.type !== "openai-responses") {
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

  const foundModel =
    providerConfig.name === "codex" ?
      getCodexModels().data.find((model) => model.id === payload.model)
    : undefined
  const model = foundModel ? applyModelOverride(foundModel) : undefined

  const maxPromptTokens = model?.capabilities.limits.max_prompt_tokens ?? 0
  // Smaller than the client compaction threshold, use server-side compaction to maintain cache hit rate
  applyResponsesApiContextManagement(payload, maxPromptTokens, 0.8)

  const contextManagement = payload.context_management
  debugJson(logger, "Translated Responses request payload:", {
    contextManagement,
    provider,
  })

  compactInputByLatestCompaction(payload)

  if (providerConfig.name === "codex") {
    const upstreamResponse = await forwardCodexResponses(
      payload,
      c.req.raw.headers,
      providerConfig.baseUrl,
    )
    const recordUsage = createProviderResponsesUsageRecorder(payload, provider)

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
  )

  if (!upstreamResponse.ok) {
    throw new HTTPError(
      `Failed to create ${provider} responses`,
      upstreamResponse,
    )
  }

  const recordUsage = createProviderResponsesUsageRecorder(payload, provider)

  if (payload.stream) {
    return streamProviderResponses(c, getResponsesEvents(upstreamResponse), {
      normalizeCodex: false,
      provider,
      recordUsage,
    })
  }

  const responseBody = (await upstreamResponse
    .clone()
    .json()) as ResponsesResult
  recordUsage(normalizeResponsesUsage(responseBody.usage))

  return createProviderProxyResponse(upstreamResponse)
}

const createProviderResponsesUsageRecorder = (
  payload: ResponsesPayload,
  provider: string,
): ((usage: UsageTokens) => void) => {
  const sessionAffinity =
    requestContext.getStore()?.sessionAffinity?.trim() || null

  return createProviderTokenUsageRecorder({
    endpoint: "responses",
    model: payload.model,
    providerName: provider,
    sessionId: sessionAffinity ?? "",
  })
}

const streamProviderResponses = (
  c: Context,
  upstreamResponse: ResponsesStream,
  options: {
    normalizeCodex: boolean
    provider: string
    recordUsage: (usage: UsageTokens) => void
  },
): Response => {
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}

    try {
      for await (const chunk of upstreamResponse) {
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
    } finally {
      options.recordUsage(usage)
    }
  })
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

const getResponsesEvents = (response: Response): ResponsesStream =>
  events(response)

const isResponsesStream = (value: unknown): value is ResponsesStream => {
  return (
    Boolean(value)
    && typeof (value as ResponsesStream)[Symbol.asyncIterator] === "function"
  )
}
