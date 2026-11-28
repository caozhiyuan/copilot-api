import consola from "consola"
import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { guardChatCompletionsStream } from "~/lib/http/chat-completions-stream"
import { resolveMappedModel } from "~/lib/config"
import { recordChatCompletionFirstToken } from "~/lib/http/first-token"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { findEndpointModel } from "~/lib/catalog/models"
import { writeSSEIfConnected } from "~/lib/http/sse"
import { setPluginRequestModel } from "~/lib/http/request-events"
import { resolveConfiguredProviderModelAlias } from "~/lib/providers/provider-resolver"
import {
  createCopilotTokenUsageRecorder,
  normalizeOpenAIUsage,
  normalizeOptionalToken,
  type UsageTokens,
} from "~/lib/token-usage"
import { generateRequestIdFromPayload, getUUID, isNullish } from "~/lib/utils"
import { normalizeToolSchema } from "~/routes/messages/completions-translation"
import { handleProviderChatCompletionsForProvider } from "~/routes/provider/chat-completions/handler"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Tool,
} from "~/lib/types/chat-completions"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

const logger = createHandlerLogger("chat-completions-handler")

export const chatCompletionsHandlerDependencies = {
  createChatCompletions,
}

export async function handleCompletion(c: Context) {
  let payload = await c.req.json<ChatCompletionsPayload>()
  setPluginRequestModel(payload.model)
  const requestedModel = payload.model
  payload.model = resolveMappedModel(payload.model)
  if (payload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }

  const providerModelAlias = await resolveConfiguredProviderModelAlias(
    payload.model,
  )
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    return await handleProviderChatCompletionsForProvider(c, {
      payload,
      provider: providerModelAlias.provider,
    })
  }

  debugJson(logger, "Request payload:", payload)

  if (Array.isArray(payload.tools)) {
    payload.tools = payload.tools.map(normalizeToolParameters)
  }

  const selectedModel = findEndpointModel(payload.model)
  payload.model = selectedModel?.id ?? payload.model

  if (
    isNullish(payload.max_tokens)
    && isNullish(payload.max_completion_tokens)
  ) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    debugJson(logger, "Set max_tokens to:", payload.max_tokens)
  }

  if (payload.model.includes("gpt")) {
    if (isNullish(payload.max_completion_tokens)) {
      payload.max_completion_tokens = payload.max_tokens
    }
    delete payload.max_tokens
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

  const response =
    await chatCompletionsHandlerDependencies.createChatCompletions(payload, {
      clientSignal: c.req.raw.signal,
      requestId,
      sessionId,
    })

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response:", response)
    recordUsage({
      ...normalizeOpenAIUsage(response.usage),
      total_nano_aiu: normalizeOptionalToken(
        response.copilot_usage?.total_nano_aiu,
      ),
    })
    return c.json(response)
  }

  logger.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}

    try {
      for await (const {
        message: chunk,
        completion: parsedChunk,
      } of guardChatCompletionsStream(response)) {
        debugJson(logger, "Streaming chunk:", chunk)
        recordChatCompletionFirstToken(parsedChunk)
        if (parsedChunk?.usage || parsedChunk?.copilot_usage) {
          usage = {
            ...normalizeOpenAIUsage(parsedChunk.usage),
            total_nano_aiu: normalizeOptionalToken(
              parsedChunk.copilot_usage?.total_nano_aiu,
            ),
          }
        }
        await writeSSEIfConnected(stream, chunk as SSEMessage)
      }
    } finally {
      recordUsage(usage)
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

// Copilot's Gemini models reject `type: "object"` tool schemas without
// `properties`, which OpenAI clients may send for argument-less tools.
// Request bodies are not validated, so tools without an object `parameters`
// schema (including malformed entries) are forwarded unchanged.
const normalizeToolParameters = (tool: Tool): Tool => {
  const value: unknown = tool
  if (
    !isRecord(value)
    || !isRecord(value.function)
    || !isRecord(value.function.parameters)
  ) {
    return tool
  }
  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: normalizeToolSchema(value.function.parameters),
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
