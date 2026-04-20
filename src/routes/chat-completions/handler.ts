import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { createHandlerLogger, debugJson, debugJsonTail } from "~/lib/logger"
import { logRequestModel } from "~/lib/model-logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getUUID, isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

const logger = createHandlerLogger("chat-completions-handler")

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  debugJsonTail(logger, "Request payload:", { value: payload, tailLength: 400 })

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  logRequestModel(payload.model)

  if (selectedModel?.id === "gpt-5.4") {
    return c.json(
      {
        error: {
          message: "Please use `/v1/responses` or `/v1/messages` API",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    debugJson(logger, "Set max_tokens to:", payload.max_tokens)
  }

  // not support subagent marker for now , set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload(payload)
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)

  const response = await createChatCompletions(payload, {
    requestId,
    sessionId,
  })

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response:", response)
    return c.json(response)
  }

  logger.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      debugJson(logger, "Streaming chunk:", chunk)
      await stream.writeSSE(chunk as SSEMessage)
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
