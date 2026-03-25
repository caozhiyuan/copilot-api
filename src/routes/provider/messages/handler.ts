import type { Context } from "hono"

import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
} from "~/routes/messages/anthropic-types"

import { getProviderConfig, type ResolvedProviderConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { forwardProviderMessages } from "~/services/providers/anthropic-proxy"

const logger = createHandlerLogger("provider-messages-handler")

export async function handleProviderMessages(c: Context): Promise<Response> {
  const provider = c.req.param("provider")
  const providerConfig = getProviderConfig(provider)
  if (!providerConfig) {
    return c.json(
      {
        error: {
          message: `Provider '${provider}' not found or disabled`,
          type: "invalid_request_error",
        },
      },
      404,
    )
  }

  try {
    const payload = await c.req.json<AnthropicMessagesPayload>()

    const modelConfig = providerConfig.models?.[payload.model]
    payload.temperature ??= modelConfig?.temperature
    payload.top_p ??= modelConfig?.topP
    payload.top_k ??= modelConfig?.topK

    logger.debug(
      "provider.messages.request",
      JSON.stringify({ payload, provider }),
    )

    const upstreamResponse = await forwardProviderMessages(
      providerConfig,
      payload,
      c.req.raw.headers,
    )

    if (!upstreamResponse.ok) {
      logger.error("Failed to create responses", upstreamResponse)
      throw new HTTPError("Failed to create responses", upstreamResponse)
    }

    const contentType = upstreamResponse.headers.get("content-type") ?? ""
    const isStreamingResponse =
      Boolean(payload.stream) && contentType.includes("text/event-stream")

    if (isStreamingResponse) {
      logger.debug("provider.messages.streaming")
      return streamSSE(c, async (stream) => {
        for await (const chunk of events(upstreamResponse)) {
          logger.debug("provider.messages.raw_stream_event:", chunk.data)
          const eventName = chunk.event
          if (eventName === "ping") {
            await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
            continue
          }

          let data = chunk.data
          if (!data) {
            continue
          }

          if (chunk.data === "[DONE]") {
            break
          }

          try {
            const parsed = JSON.parse(data) as AnthropicStreamEventData
            if (parsed.type === "message_start") {
              adjustInputTokens(providerConfig, parsed.message.usage)
            } else if (parsed.type === "message_delta") {
              adjustInputTokens(providerConfig, parsed.usage)
            }
            data = JSON.stringify(parsed)
          } catch (error) {
            logger.error("provider.messages.streaming.adjust_tokens_error", {
              error,
              originalData: data,
            })
          }
          await stream.writeSSE({
            event: eventName,
            data,
          })
        }
      })
    }

    const jsonBody = (await upstreamResponse.json()) as AnthropicResponse

    adjustInputTokens(providerConfig, jsonBody.usage)

    logger.debug(
      "provider.messages.no_stream result:",
      JSON.stringify(jsonBody),
    )
    return c.json(jsonBody)
  } catch (error) {
    logger.error("provider.messages.error", {
      provider,
      error,
    })
    throw error
  }
}

const adjustInputTokens = (
  providerConfig: ResolvedProviderConfig,
  usage?: {
    input_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  },
): void => {
  if (!providerConfig.adjustInputTokens || !usage) {
    return
  }
  const adjustedInput = Math.max(
    0,
    (usage.input_tokens ?? 0)
      - (usage.cache_read_input_tokens ?? 0)
      - (usage.cache_creation_input_tokens ?? 0),
  )
  usage.input_tokens = adjustedInput
  logger.debug("provider.messages.adjusted_usage:", JSON.stringify(usage))
}
