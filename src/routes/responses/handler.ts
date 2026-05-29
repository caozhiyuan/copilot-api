import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { isResponsesApiWebSearchEnabled as isConfiguredResponsesApiWebSearchEnabled } from "~/lib/config"
import { createHandlerLogger, debugJson, debugJsonTail } from "~/lib/logger"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { checkRateLimit as checkConfiguredRateLimit } from "~/lib/rate-limit"
import { handleProviderResponsesForProvider } from "~/routes/provider/responses/handler"
import { state } from "~/lib/state"
import {
  createCopilotTokenUsageRecorder,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { generateRequestIdFromPayload, getUUID } from "~/lib/utils"
import {
  createResponses as createCopilotResponses,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"
import { HTTPError } from "~/lib/error"

import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesTransportForModel,
  getResponsesRequestOptions,
  sanitizeAllInputImages,
  sanitizeOversizedInputImages,
} from "./utils"

const logger = createHandlerLogger("responses-handler")

export const responsesHandlerDependencies = {
  checkRateLimit: checkConfiguredRateLimit,
  createResponses: createCopilotResponses,
  isResponsesApiWebSearchEnabled: isConfiguredResponsesApiWebSearchEnabled,
}

export const handleResponses = async (c: Context) => {
  const payload = await c.req.json<ResponsesPayload>()

  const providerModelAlias = parseProviderModelAlias(payload.model)
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    return await handleProviderResponsesForProvider(c, {
      payload,
      provider: providerModelAlias.provider,
    })
  }

  debugJson(logger, "Responses request payload:", payload)
  await responsesHandlerDependencies.checkRateLimit(state)

  // not support subagent marker for now , set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload({ messages: payload.input })
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "responses",
    fallbackSessionId: sessionId,
    model: payload.model,
  })

  removeUnsupportedTools(payload)

  if (!responsesHandlerDependencies.isResponsesApiWebSearchEnabled()) {
    removeWebSearchTool(payload)
  }

  compactInputByLatestCompaction(payload)

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const responsesTransport = getResponsesTransportForModel(selectedModel)

  if (!responsesTransport) {
    return c.json(
      {
        error: {
          message:
            "This model does not support the responses endpoint. Please choose a different model.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  const sanitizedImageCount = sanitizeOversizedInputImages(
    payload,
    selectedModel?.capabilities.limits.vision?.max_prompt_image_size,
  )
  if (sanitizedImageCount > 0) {
    logger.warn(
      `Omitted ${sanitizedImageCount} oversized input image(s) before forwarding to Copilot Responses`,
    )
  }

  applyResponsesApiContextManagement(
    payload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )

  debugJson(logger, "Translated Responses payload:", payload)

  const { vision, initiator } = getResponsesRequestOptions(payload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const responseOptions = {
    vision,
    initiator,
    requestId,
    sessionId: sessionId,
    transport: responsesTransport,
  }
  let response: Awaited<ReturnType<typeof createCopilotResponses>>
  try {
    response = await responsesHandlerDependencies.createResponses(
      payload,
      responseOptions,
    )
  } catch (error) {
    if (!(error instanceof HTTPError) || error.response.status !== 413) {
      throw error
    }

    const retrySanitizedImageCount = sanitizeAllInputImages(payload)
    if (retrySanitizedImageCount === 0) {
      throw error
    }

    logger.warn(
      `Omitted ${retrySanitizedImageCount} input image(s) after Copilot Responses rejected the payload as too large`,
    )
    const retryOptions = {
      ...responseOptions,
      vision: getResponsesRequestOptions(payload).vision,
    }
    response = await responsesHandlerDependencies.createResponses(
      payload,
      retryOptions,
    )
  }

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    logger.debug("Forwarding native Responses stream")
    return streamSSE(c, async (stream) => {
      const idTracker = createStreamIdTracker()
      let usage: UsageTokens = {}

      for await (const chunk of response) {
        debugJson(logger, "Responses stream chunk:", chunk)
        const parsedEvent = parseResponsesStreamEvent(chunk)
        if (
          parsedEvent?.type === "response.completed"
          || parsedEvent?.type === "response.failed"
          || parsedEvent?.type === "response.incomplete"
        ) {
          usage = normalizeResponsesUsage(parsedEvent.response.usage)
        }

        const processedData = fixStreamIds(
          (chunk as { data?: string }).data ?? "",
          (chunk as { event?: string }).event,
          idTracker,
        )

        await stream.writeSSE({
          id: (chunk as { id?: string }).id,
          event: (chunk as { event?: string }).event,
          data: processedData,
        })
      }

      recordUsage(usage)
    })
  }

  debugJsonTail(logger, "Forwarding native Responses result:", {
    value: response,
    tailLength: 400,
  })
  recordUsage(normalizeResponsesUsage((response as ResponsesResult).usage))
  return c.json(response as ResponsesResult)
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const parseResponsesStreamEvent = (
  chunk: unknown,
): ResponseStreamEvent | null => {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") {
    return null
  }

  try {
    return JSON.parse(data) as ResponseStreamEvent
  } catch {
    return null
  }
}

const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}

const COPILOT_UNSUPPORTED_TOOL_TYPES = new Set(["image_generation"])

export const removeUnsupportedTools = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  const dropped: Array<string> = []
  payload.tools = payload.tools.filter((t) => {
    const type = t.type as string
    if (COPILOT_UNSUPPORTED_TOOL_TYPES.has(type)) {
      dropped.push(type)
      return false
    }
    return true
  })
  if (dropped.length > 0) {
    logger.debug("Removed unsupported tools:", dropped)
  }
}
