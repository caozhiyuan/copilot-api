import consola from "consola"
import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { resolveMappedModel } from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createCopilotTokenUsageRecorder,
  normalizeOpenAIUsage,
  type CopilotUsageTokens,
  type UsageTokens,
} from "~/lib/token-usage"
import { generateRequestIdFromPayload, getUUID, isNullish } from "~/lib/utils"
import { handleProviderChatCompletionsForProvider } from "~/routes/provider/chat-completions/handler"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type CopilotUsage,
} from "~/services/copilot/create-chat-completions"

const logger = createHandlerLogger("chat-completions-handler")

export async function handleCompletion(c: Context) {
  let payload = await c.req.json<ChatCompletionsPayload>()
  const requestedModel = payload.model
  payload.model = resolveMappedModel(payload.model)
  if (payload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }

  const providerModelAlias = parseProviderModelAlias(payload.model)
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    return await handleProviderChatCompletionsForProvider(c, {
      payload,
      provider: providerModelAlias.provider,
    })
  }

  await checkRateLimit(state)

  debugJson(logger, "Request payload:", payload)

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

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
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "chat_completions",
    fallbackSessionId: sessionId,
    model: payload.model,
  })

  const response = await createChatCompletions(payload, {
    requestId,
    sessionId,
  })

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response:", response)
    recordUsage(
      normalizeOpenAIUsage(response.usage),
      copilotUsageFromResponse(response.copilot_usage),
    )
    return c.json(response)
  }

  logger.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    let copilotUsage: CopilotUsageTokens = {}

    for await (const chunk of response) {
      debugJson(logger, "Streaming chunk:", chunk)
      const parsedChunk = parseChatCompletionChunk(chunk)
      if (parsedChunk?.usage) {
        usage = normalizeOpenAIUsage(parsedChunk.usage)
      }
      if (parsedChunk?.copilot_usage) {
        copilotUsage = copilotUsageFromResponse(parsedChunk.copilot_usage)
      }
      await stream.writeSSE(chunk as SSEMessage)
    }

    recordUsage(usage, copilotUsage)
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const parseChatCompletionChunk = (
  chunk: unknown,
): ChatCompletionChunk | null => {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") {
    return null
  }

  try {
    return JSON.parse(data) as ChatCompletionChunk
  } catch {
    return null
  }
}

function copilotUsageFromResponse(
  copilotUsage: CopilotUsage | undefined,
): CopilotUsageTokens {
  if (!copilotUsage) {
    return {}
  }

  return {
    token_details: copilotUsage.token_details,
    total_nano_aiu: copilotUsage.total_nano_aiu,
  }
}
