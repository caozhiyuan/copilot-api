import { events } from "fetch-event-stream"
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import {
  type ModelConfig,
  type ResolvedProviderConfig,
  resolveEffectiveProviderType,
} from "~/lib/config"
import {
  applyDashScopePreserveThinkingDefault,
  applyOpenAICompatibleContextCache,
  isDashScopeAliyunProvider,
} from "~/lib/dashscope"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { assertAllowedModelSelection } from "~/lib/model-admission"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { writeSSEIfConnected } from "~/lib/sse"
import {
  createProviderTokenUsageRecorder,
  normalizeOpenAIUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/lib/types/chat-completions"
import {
  createProviderProxyResponse,
  forwardProviderChatCompletions,
} from "~/services/providers/provider-proxy"
import {
  applyMissingExtraBody,
  applyModelDefaults,
} from "~/routes/provider/utils"

const logger = createHandlerLogger("provider-chat-completions-handler")

export async function handleProviderChatCompletionsForProvider(
  c: Context,
  options: {
    payload: ChatCompletionsPayload
    provider: string
  },
): Promise<Response> {
  const { payload, provider } = options
  assertAllowedModelSelection(payload)

  const providerConfig = await resolveProviderConfig(provider)
  if (
    !providerConfig
    || resolveEffectiveProviderType(providerConfig, payload.model)
      !== "openai-compatible"
  ) {
    return c.json(
      {
        error: {
          message: `Provider '${provider}' does not support the /v1/chat/completions endpoint`,
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  const modelConfig = providerConfig.models?.[payload.model]
  applyModelDefaults(payload, modelConfig)
  applyMissingExtraBody(payload, {
    extraBody: modelConfig?.extraBody,
  })
  applyProviderStreamOptions(payload)
  applyDashScopePreserveThinkingDefault(
    payload as unknown as Record<string, unknown>,
    providerConfig,
  )
  applyProviderContextCache(payload, modelConfig, providerConfig)
  assertAllowedModelSelection(payload)

  debugJson(logger, "provider.chat_completions.request", {
    payload,
    provider,
  })

  const upstreamResponse = await forwardProviderChatCompletions(
    providerConfig,
    payload,
    c.req.raw.headers,
    { clientSignal: c.req.raw.signal },
  )

  if (!upstreamResponse.ok) {
    logger.error("Failed to create provider chat completions", {
      provider,
      statusCode: upstreamResponse.status,
    })
    throw new HTTPError(
      `Failed to create ${provider} chat completions`,
      upstreamResponse,
    )
  }

  const recordUsage = createProviderChatCompletionsUsageRecorder(
    payload,
    provider,
    modelConfig,
    providerConfig.pricingCurrency,
  )
  const contentType = upstreamResponse.headers.get("content-type") ?? ""
  const isStreamingResponse =
    Boolean(payload.stream) && contentType.includes("text/event-stream")

  if (isStreamingResponse) {
    return streamProviderChatCompletions(c, upstreamResponse, {
      provider,
      recordUsage,
    })
  }

  const responseBody = (await upstreamResponse
    .clone()
    .json()) as ChatCompletionResponse
  recordUsage(normalizeOpenAIUsage(responseBody.usage))

  debugJson(logger, "provider.chat_completions.response", responseBody)
  return createProviderProxyResponse(upstreamResponse)
}

const applyProviderStreamOptions = (payload: ChatCompletionsPayload): void => {
  if (!payload.stream) {
    return
  }

  payload.stream_options = {
    ...(payload.stream_options ?? {}),
    include_usage: true,
  }
}

const applyProviderContextCache = (
  payload: ChatCompletionsPayload,
  modelConfig: ModelConfig | undefined,
  providerConfig: ResolvedProviderConfig,
): void => {
  const isDashScopeProvider = isDashScopeAliyunProvider(providerConfig)
  const contextCacheEnabled = modelConfig?.contextCache ?? isDashScopeProvider
  if (contextCacheEnabled) {
    applyOpenAICompatibleContextCache(payload)
  }
}

const createProviderChatCompletionsUsageRecorder = (
  payload: ChatCompletionsPayload,
  provider: string,
  modelConfig: ModelConfig | undefined,
  pricingCurrency: string | undefined,
) =>
  createProviderTokenUsageRecorder({
    endpoint: "chat_completions",
    model: payload.model,
    pricing: modelConfig?.pricing,
    pricingCurrency,
    providerName: provider,
  })

const streamProviderChatCompletions = (
  c: Context,
  upstreamResponse: Response,
  options: {
    provider: string
    recordUsage: (usage: UsageTokens) => void
  },
): Response => {
  logger.debug("provider.chat_completions.streaming", {
    provider: options.provider,
  })
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}

    try {
      for await (const chunk of events(upstreamResponse)) {
        debugJson(logger, "provider.chat_completions.stream_chunk", chunk)
        if (chunk.data && chunk.data !== "[DONE]") {
          const parsedChunk = parseChatCompletionChunkData(chunk.data)
          if (parsedChunk?.usage) {
            usage = normalizeOpenAIUsage(parsedChunk.usage)
          }
        }

        await writeSSEIfConnected(stream, {
          event: chunk.event,
          data: chunk.data ?? "",
        })
      }
    } finally {
      options.recordUsage(usage)
    }
  })
}

const parseChatCompletionChunkData = (
  data: string,
): ChatCompletionChunk | null => {
  try {
    return JSON.parse(data) as ChatCompletionChunk
  } catch {
    return null
  }
}
