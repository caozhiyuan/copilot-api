import type { Context } from "hono"

import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { getProviderConfig } from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"
import {
  createProviderProxyResponse,
  forwardProviderMessages,
} from "~/services/providers/anthropic-proxy"

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

    payload.temperature ??= providerConfig.defaultTemperature
    payload.top_p ??= providerConfig.defaultTopP
    payload.top_k ??= providerConfig.defaultTopK

    logger.debug(
      "provider.messages.request",
      JSON.stringify({ payload, provider }),
    )

    const upstreamResponse = await forwardProviderMessages(
      providerConfig,
      payload,
      c.req.raw.headers,
    )

    const contentType = upstreamResponse.headers.get("content-type") ?? ""
    const isStreamingResponse =
      Boolean(payload.stream) && contentType.includes("text/event-stream")

    if (isStreamingResponse) {
      logger.debug("provider.messages.streaming")
      return streamSSE(c, async (stream) => {
        for await (const event of events(upstreamResponse)) {
          const eventName = event.event
          const data = event.data ?? ""
          logger.debug("provider.messages.raw_stream_event", data)
          await stream.writeSSE({
            event: eventName,
            data,
          })
        }
      })
    }

    return createProviderProxyResponse(upstreamResponse)
  } catch (error) {
    logger.error("provider.messages.error", {
      provider,
      error,
    })
    throw error
  }
}
