import type { Context } from "hono"

import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
} from "~/lib/types/anthropic"

import { type ModelConfig } from "~/lib/config"
import { recordAnthropicFirstToken } from "~/lib/first-token"
import { debugJson } from "~/lib/logger"
import { writeSSEIfConnected } from "~/lib/sse"
import {
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
  type TokenUsageEndpoint,
  type UsageTokens,
} from "~/lib/token-usage"
import { translateErrorToAnthropicErrorEvent } from "~/routes/messages/completions-stream-translation"

import { logger } from "./log"
import { createProviderMessagesUsageRecorder } from "./usage"

export const streamProviderMessages = ({
  c,
  modelConfig,
  payload,
  pricingCurrency,
  provider,
  upstreamResponse,
  usageEndpoint,
}: {
  c: Context
  modelConfig: ModelConfig | undefined
  payload: AnthropicMessagesPayload
  pricingCurrency: string | undefined
  provider: string
  upstreamResponse: Response
  usageEndpoint?: TokenUsageEndpoint
}): Response => {
  logger.debug("provider.messages.streaming")
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
    usageEndpoint,
  )
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    let messageStopSeen = false
    let errorSeen = false
    const openRouterThinkingState: OpenRouterThinkingStreamState = {
      signedThinkingBlockIndexes: new Set<number>(),
      thinkingBlockIndexes: new Set<number>(),
    }

    try {
      for await (const chunk of events(upstreamResponse)) {
        logger.debug("provider.messages.raw_stream_event:", chunk.data)
        const eventName = chunk.event
        if (eventName === "ping") {
          await writeSSEIfConnected(stream, {
            event: "ping",
            data: '{"type":"ping"}',
          })
          continue
        }

        let data = chunk.data
        if (!data) {
          continue
        }

        if (chunk.data === "[DONE]") {
          break
        }

        const parsed = parseProviderStreamEvent(data)
        if (parsed) {
          usage = mergeAnthropicUsage(usage, parsed.usage)
          data = parsed.data
          if (parsed.type === "message_stop") {
            messageStopSeen = true
          } else if (parsed.type === "error") {
            errorSeen = true
          }
        }

        const streamEvents =
          provider === "openrouter" ?
            normalizeOpenRouterStreamEvents(
              eventName,
              data,
              openRouterThinkingState,
            )
          : [{ data, event: eventName }]
        for (const streamEvent of streamEvents) {
          await writeSSEIfConnected(
            stream,
            {
              event: streamEvent.event,
              data: streamEvent.data,
            },
            parsed?.type,
          )
        }
      }
    } catch (error) {
      logger.warn("provider.messages.stream_interrupted:", { error, provider })
    }

    if (!messageStopSeen && !errorSeen) {
      logger.warn("provider.messages.stream_incomplete:", { provider })
      const errorEvent = translateErrorToAnthropicErrorEvent()
      await writeSSEIfConnected(stream, {
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      })
    }

    recordUsage(usage)
  })
}

export const parseProviderStreamEvent = (
  data: string,
): {
  data: string
  model?: string
  type: AnthropicStreamEventData["type"]
  usage: UsageTokens
} | null => {
  try {
    const parsed = JSON.parse(data) as AnthropicStreamEventData
    recordAnthropicFirstToken(parsed)
    if (parsed.type === "message_start") {
      return {
        data: JSON.stringify(parsed),
        model: parsed.message.model,
        type: parsed.type,
        usage: normalizeAnthropicUsage(parsed.message.usage),
      }
    }
    if (parsed.type === "message_delta") {
      return {
        data: JSON.stringify(parsed),
        type: parsed.type,
        usage: normalizeAnthropicUsage(parsed.usage),
      }
    }
    return { data: JSON.stringify(parsed), type: parsed.type, usage: {} }
  } catch (error) {
    logger.error("provider.messages.streaming.adjust_tokens_error", {
      error,
      originalData: data,
    })
    return null
  }
}

export const normalizeOpenRouterThinkingSignatures = (
  body: AnthropicResponse,
): void => {
  for (const block of body.content) {
    if (block.type === "thinking") {
      block.signature ??= ""
    }
  }
}

export type OpenRouterThinkingStreamState = {
  signedThinkingBlockIndexes: Set<number>
  thinkingBlockIndexes: Set<number>
}

export type ProviderStreamEvent = {
  data: string
  event: string | undefined
}

export const normalizeOpenRouterStreamEvents = (
  eventName: string | undefined,
  data: string,
  state: OpenRouterThinkingStreamState,
): Array<ProviderStreamEvent> => {
  let event: AnthropicStreamEventData
  try {
    event = JSON.parse(data) as typeof event
  } catch {
    return [{ data, event: eventName }]
  }

  if (
    event.type === "content_block_start"
    && event.content_block.type === "thinking"
  ) {
    const { index } = event
    state.thinkingBlockIndexes.add(index)
    state.signedThinkingBlockIndexes.delete(index)
  }

  if (
    event.type === "content_block_delta"
    && event.delta.type === "signature_delta"
  ) {
    const { index } = event
    state.signedThinkingBlockIndexes.add(index)
  }

  if (event.type === "content_block_stop") {
    const { index } = event
    if (!state.thinkingBlockIndexes.has(index)) {
      return [{ data, event: eventName }]
    }

    const hasSignature = state.signedThinkingBlockIndexes.has(index)
    state.thinkingBlockIndexes.delete(index)
    state.signedThinkingBlockIndexes.delete(index)

    if (!hasSignature) {
      return [
        {
          data: JSON.stringify({
            delta: { signature: "", type: "signature_delta" },
            index,
            type: "content_block_delta",
          }),
          event: "content_block_delta",
        },
        { data, event: eventName },
      ]
    }
  }

  return [{ data, event: eventName }]
}

export const respondProviderMessagesJson = (
  c: Context,
  options: {
    body: AnthropicResponse
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    pricingCurrency: string | undefined
    provider: string
    usageEndpoint?: TokenUsageEndpoint
  },
): Response => {
  const {
    body,
    modelConfig,
    payload,
    pricingCurrency,
    provider,
    usageEndpoint,
  } = options
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
    usageEndpoint,
  )
  recordUsage(normalizeAnthropicUsage(body.usage))

  if (provider === "openrouter") {
    normalizeOpenRouterThinkingSignatures(body)
  }

  debugJson(logger, "provider.messages.no_stream result:", body)
  return c.json(body)
}
