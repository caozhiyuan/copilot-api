import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { createHandlerLogger } from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { generateRequestIdFromPayload, getUUID, isNullish } from "~/lib/utils"
import { getResponsesRequestOptions } from "~/routes/responses/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponseStreamEvent,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

import {
  CHAT_COMPLETIONS_ENDPOINT,
  RESPONSES_ENDPOINT_PATH,
  createResponsesCompletionStreamState,
  translateChatCompletionsToResponsesPayload,
  translateResponsesEventToChunks,
  translateResponsesResultToChatCompletion,
} from "./responses-fallback"

const logger = createHandlerLogger("chat-completions-handler")

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  logger.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      logger.info("Current token count:", tokenCount)
    } else {
      logger.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    logger.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    logger.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  // not support subagent marker for now , set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload(payload)
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)

  // If the model doesn't support /chat/completions but supports /responses,
  // translate and route through the Responses API
  const endpoints = selectedModel?.supported_endpoints
  const supportsChatCompletions =
    !endpoints || endpoints.includes(CHAT_COMPLETIONS_ENDPOINT)
  const supportsResponses =
    endpoints?.includes(RESPONSES_ENDPOINT_PATH) ?? false

  if (!supportsChatCompletions && supportsResponses) {
    logger.debug(
      "Model only supports Responses API, routing via /responses:",
      payload.model,
    )
    return handleViaResponsesApi(c, payload, { requestId, sessionId })
  }

  const response = await createChatCompletions(payload, {
    requestId,
    sessionId,
  })

  if (isNonStreaming(response)) {
    logger.debug("Non-streaming response:", JSON.stringify(response))
    return c.json(response)
  }

  logger.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      logger.debug("Streaming chunk:", JSON.stringify(chunk))
      await stream.writeSSE(chunk as SSEMessage)
    }
  })
}

const handleViaResponsesApi = async (
  c: Context,
  payload: ChatCompletionsPayload,
  options: { requestId: string; sessionId: string },
) => {
  const { requestId, sessionId } = options
  const responsesPayload = translateChatCompletionsToResponsesPayload(payload)
  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)

  const response = await createResponses(responsesPayload, {
    vision,
    initiator,
    requestId,
    sessionId,
  })

  if (isResponsesNonStreaming(response)) {
    logger.debug("Non-streaming Responses result")
    return c.json(translateResponsesResultToChatCompletion(response))
  }

  logger.debug("Streaming Responses response")
  const streamState = createResponsesCompletionStreamState(payload.model)
  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      if (chunk.event === "ping") continue
      if (!chunk.data) continue

      const event = JSON.parse(chunk.data) as ResponseStreamEvent
      const sseMessages = translateResponsesEventToChunks(event, streamState)
      for (const msg of sseMessages) {
        logger.debug("Responses→completion chunk:", msg.data)
        await stream.writeSSE(msg)
      }

      if (streamState.finishReason !== null) break
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isResponsesNonStreaming = (
  response: Awaited<ReturnType<typeof createResponses>>,
): response is ResponsesResult => Object.hasOwn(response, "output")
