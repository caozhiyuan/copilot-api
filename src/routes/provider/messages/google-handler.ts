import type { Context } from "hono"

import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import type { ResolvedProviderConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { recordGoogleFirstToken } from "~/lib/first-token"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { writeSSEIfConnected } from "~/lib/sse"
import {
  createProviderTokenUsageRecorder,
  normalizeAnthropicUsage,
  type TokenUsageEndpoint,
} from "~/lib/token-usage"
import type {
  AnthropicMessagesPayload,
  AnthropicStreamEventData,
} from "~/lib/types/anthropic"
import type { GoogleGenerateContentResponse } from "~/lib/types/google"
import { parseUserIdMetadata } from "~/lib/utils"
import { GoogleMessagesStreamTranslator } from "~/routes/messages/google-stream-translation"
import {
  translateAnthropicToGoogle,
  translateGoogleToAnthropic,
} from "~/routes/messages/google-translation"
import { applyMissingExtraBody } from "~/routes/provider/utils"
import { forwardGoogleGenerateContent } from "~/services/providers/google"
import { resolveOpencodeMessagesSession } from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("provider-google-messages")

export async function handleGoogleProviderMessages(
  c: Context,
  payload: AnthropicMessagesPayload,
  provider: ResolvedProviderConfig,
  usageEndpoint?: TokenUsageEndpoint,
): Promise<Response> {
  debugJson(logger, "provider.messages.google.original_request", payload)
  const translated = translateAnthropicToGoogle(payload)
  const modelConfig = provider.models?.[payload.model]
  const extraGenerationConfig = modelConfig?.extraBody?.generationConfig
  if (
    extraGenerationConfig
    && typeof extraGenerationConfig === "object"
    && !Array.isArray(extraGenerationConfig)
  ) {
    const generationConfig = translated.generationConfig as unknown as Record<
      string,
      unknown
    >
    for (const [key, value] of Object.entries(extraGenerationConfig)) {
      if (generationConfig[key] === undefined) generationConfig[key] = value
    }
  }
  applyMissingExtraBody(translated as unknown as Record<string, unknown>, {
    extraBody: modelConfig?.extraBody,
  })
  debugJson(logger, "provider.messages.google.request", translated)
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, c.req.raw.signal])
  const upstream = await forwardGoogleGenerateContent(
    provider,
    payload.model,
    translated,
    c.req.raw.headers,
    {
      stream: payload.stream === true,
      clientSignal: signal,
      sessionId: resolveOpencodeMessagesSession(payload),
    },
  )
  if (!upstream.ok)
    throw new HTTPError("Failed to create Google response", upstream)
  const recordUsage = createProviderTokenUsageRecorder({
    endpoint: usageEndpoint ?? "provider_messages",
    model: payload.model,
    providerName: provider.name,
    pricing: modelConfig?.pricing,
    pricingCurrency: provider.pricingCurrency,
    sessionId: parseUserIdMetadata(payload.metadata?.user_id).sessionId,
  })
  if (!payload.stream) {
    const response = translateGoogleToAnthropic(
      (await upstream.json()) as GoogleGenerateContentResponse,
      payload.model,
    )
    recordUsage(normalizeAnthropicUsage(response.usage))
    return c.json(response)
  }
  return streamSSE(c, async (stream) => {
    const translator = new GoogleMessagesStreamTranslator(payload.model)
    stream.onAbort(() => controller.abort())
    const writeEvents = async (items: Array<AnthropicStreamEventData>) => {
      for (const item of items) {
        debugJson(logger, "provider.messages.google.translated_event:", item)
        await writeSSEIfConnected(stream, {
          event: item.type,
          data: JSON.stringify(item),
        })
      }
    }
    try {
      // fetch-event-stream checks aborts between events. An abortable pipe also
      // cancels a pending body read when Google stops sending new events.
      const response = new Response(
        upstream.body?.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>(),
          { signal },
        ),
        { headers: upstream.headers },
      )
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        for await (const event of events(response, signal)) {
          if (!event.data || event.data === "[DONE]") continue
          const response = JSON.parse(
            event.data,
          ) as GoogleGenerateContentResponse
          recordGoogleFirstToken(response)
          debugJson(
            logger,
            "provider.messages.google.raw_stream_event:",
            response,
          )
          await writeEvents(translator.push(response))
        }
      } else {
        await writeEvents(
          translator.push(
            (await response.json()) as GoogleGenerateContentResponse,
          ),
        )
      }
      if (!signal.aborted) await writeEvents(translator.finish())
    } catch (error) {
      if (!signal.aborted) {
        logger.warn("provider.messages.google.stream_interrupted", error)
        await writeEvents([
          {
            type: "error",
            error: {
              type: "api_error",
              message:
                error instanceof Error ?
                  error.message
                : "Google stream interrupted",
            },
          },
        ])
      }
    } finally {
      controller.abort()
      recordUsage(normalizeAnthropicUsage(translator.usage))
    }
  })
}
