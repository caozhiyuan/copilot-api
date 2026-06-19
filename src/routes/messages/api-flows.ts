import type { ConsolaInstance } from "consola"
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type { Model } from "~/services/copilot/get-models"

import { debugJson, debugJsonTail, debugLazy } from "~/lib/logger"
import { resolveBridgeToolSearchName } from "~/lib/tool-search"
import {
  createCopilotTokenUsageRecorder,
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  normalizeOptionalToken,
  normalizeResponsesUsage,
  type TokenUsageEndpoint,
  type UsageTokens,
} from "~/lib/token-usage"
import { parseUserIdMetadata } from "~/lib/utils"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesTransportForModel,
  getResponsesRequestOptions,
} from "~/routes/responses/utils"
import {
  createChatCompletions as createCopilotChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type Message,
} from "~/services/copilot/create-chat-completions"
import { createMessages as createCopilotMessages } from "~/services/copilot/create-messages"
import {
  createResponses as createCopilotResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { prepareMessagesApiPayload } from "./preprocess"
import {
  flushPendingAnthropicStreamEvents,
  translateChunkToAnthropicEvents,
} from "./stream-translation"

const COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT = 2
const COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT = 2
const COPILOT_CONTEXT_CACHE_CONTROL = {
  type: "ephemeral",
} as const

export const messagesApiFlowDependencies = {
  createChatCompletions: createCopilotChatCompletions,
  createMessages: createCopilotMessages,
  createResponses: createCopilotResponses,
}

export interface FlowBaseOptions {
  logger: ConsolaInstance
  subagentMarker?: SubagentMarker | null
  requestId: string
  sessionId?: string
  compactType?: CompactType
}

interface ResponsesFlowOptions extends FlowBaseOptions {
  selectedModel?: Model
}

interface MessagesFlowOptions extends FlowBaseOptions {
  anthropicBetaHeader?: string
  selectedModel?: Model
}

interface ChatCompletionsFlowOptions extends FlowBaseOptions {
  selectedModel?: Model
}

export const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: ChatCompletionsFlowOptions,
) => {
  const {
    logger,
    selectedModel,
    subagentMarker,
    requestId,
    sessionId,
    compactType,
  } = options
  const openAIPayload = translateToOpenAI(anthropicPayload, {
    validateReasoningEffort: true,
    reasoningEffortSupport:
      selectedModel?.capabilities.supports.reasoning_effort,
  })
  prepareCopilotChatCompletionsPayload(openAIPayload)
  const recordUsage = createCopilotUsageRecorder({
    endpoint: "chat_completions",
    fallbackSessionId: sessionId,
    model: openAIPayload.model,
    payload: anthropicPayload,
  })
  debugJson(logger, "Translated OpenAI request payload:", openAIPayload)

  const response = await messagesApiFlowDependencies.createChatCompletions(
    openAIPayload,
    {
      subagentMarker,
      requestId,
      sessionId,
      compactType,
    },
  )

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response from Copilot:", response)
    recordUsage({
      ...normalizeOpenAIUsage(response.usage),
      total_nano_aiu: normalizeOptionalToken(
        response.copilot_usage?.total_nano_aiu,
      ),
    })
    const anthropicResponse = translateToAnthropic(response)
    debugJson(logger, "Translated Anthropic response:", anthropicResponse)
    return c.json(anthropicResponse)
  }

  logger.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }

    for await (const rawEvent of response) {
      debugJson(logger, "Copilot raw stream event:", rawEvent)
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      if (chunk.usage || chunk.copilot_usage) {
        usage = {
          ...normalizeOpenAIUsage(chunk.usage),
          total_nano_aiu: normalizeOptionalToken(
            chunk.copilot_usage?.total_nano_aiu,
          ),
        }
      }
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        const eventData = JSON.stringify(event)
        debugLazy(logger, () => ["Translated Anthropic event:", eventData])
        await stream.writeSSE({
          event: event.type,
          data: eventData,
        })
      }
    }

    for (const event of flushPendingAnthropicStreamEvents(streamState)) {
      const eventData = JSON.stringify(event)
      debugLazy(logger, () => ["Translated Anthropic event:", eventData])
      await stream.writeSSE({
        event: event.type,
        data: eventData,
      })
    }

    recordUsage(usage)
  })
}

export const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: ResponsesFlowOptions,
) => {
  const { logger, selectedModel, ...requestOptions } = options

  const responsesPayload = translateAnthropicMessagesToResponsesPayload(
    anthropicPayload,
    requestOptions.subagentMarker?.agent_id,
  )
  const recordUsage = createCopilotUsageRecorder({
    endpoint: "responses",
    fallbackSessionId: requestOptions.sessionId,
    model: responsesPayload.model,
    payload: anthropicPayload,
  })

  applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )

  compactInputByLatestCompaction(responsesPayload)

  debugJson(logger, "Translated Responses payload:", responsesPayload)

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const transport =
    getResponsesTransportForModel(selectedModel, {
      compactType: requestOptions.compactType,
    }) ?? "http"
  const response = await messagesApiFlowDependencies.createResponses(
    responsesPayload,
    {
      vision,
      initiator,
      transport,
      ...requestOptions,
    },
  )

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return streamSSE(c, async (stream) => {
      const streamState = createResponsesStreamState({
        toolSearchName: resolveBridgeToolSearchName(anthropicPayload.tools),
      })
      let usage: UsageTokens = {}

      for await (const chunk of response) {
        const eventName = chunk.event
        if (eventName === "ping") {
          await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
          continue
        }

        const data = chunk.data
        if (!data) {
          continue
        }

        debugLazy(logger, () => ["Responses raw stream event:", data])

        const responseEvent = JSON.parse(data) as ResponseStreamEvent
        if (
          responseEvent.type === "response.completed"
          || responseEvent.type === "response.failed"
          || responseEvent.type === "response.incomplete"
        ) {
          usage = {
            ...normalizeResponsesUsage(responseEvent.response.usage),
            total_nano_aiu: normalizeOptionalToken(
              responseEvent.response.copilot_usage?.total_nano_aiu,
            ),
          }
        }

        const events = translateResponsesStreamEvent(responseEvent, streamState)
        for (const event of events) {
          const eventData = JSON.stringify(event)
          debugLazy(logger, () => ["Translated Anthropic event:", eventData])
          await stream.writeSSE({
            event: event.type,
            data: eventData,
          })
        }

        if (streamState.messageCompleted) {
          logger.debug("Message completed, ending stream")
          break
        }
      }

      if (!streamState.messageCompleted) {
        logger.warn(
          "Responses stream ended without completion; sending error event",
        )
        const errorEvent = buildErrorEvent(
          "Responses stream ended without completion",
        )
        await stream.writeSSE({
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      }

      recordUsage(usage)
    })
  }

  debugJsonTail(logger, "Non-streaming Responses result:", {
    value: response,
    tailLength: 400,
  })
  const anthropicResponse = translateResponsesResultToAnthropic(
    response as ResponsesResult,
    {
      toolSearchName: resolveBridgeToolSearchName(anthropicPayload.tools),
    },
  )
  const responsesResult = response as ResponsesResult
  recordUsage({
    ...normalizeResponsesUsage(responsesResult.usage),
    total_nano_aiu: normalizeOptionalToken(
      responsesResult.copilot_usage?.total_nano_aiu,
    ),
  })
  debugJson(logger, "Translated Anthropic response:", anthropicResponse)
  return c.json(anthropicResponse)
}

export const handleWithMessagesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: MessagesFlowOptions,
) => {
  const {
    logger,
    anthropicBetaHeader,
    subagentMarker,
    selectedModel,
    requestId,
    sessionId,
    compactType,
  } = options

  prepareMessagesApiPayload(anthropicPayload, selectedModel)
  const recordUsage = createCopilotUsageRecorder({
    endpoint: "messages",
    fallbackSessionId: sessionId,
    model: anthropicPayload.model,
    payload: anthropicPayload,
  })

  debugJson(logger, "Translated Messages payload:", anthropicPayload)

  const response = await messagesApiFlowDependencies.createMessages(
    anthropicPayload,
    anthropicBetaHeader,
    {
      subagentMarker,
      requestId,
      sessionId,
      compactType,
    },
  )

  if (isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Messages API)")
    return streamSSE(c, async (stream) => {
      let usage: UsageTokens = {}

      for await (const event of response) {
        const eventName = event.event
        const data = event.data ?? ""
        if (data === "[DONE]") {
          break
        }
        if (!data) {
          continue
        }
        debugLazy(logger, () => ["Messages raw stream event:", data])
        const parsedEvent = parseAnthropicStreamEvent(data)
        if (parsedEvent?.type === "message_start") {
          usage = mergeAnthropicUsage(
            usage,
            normalizeAnthropicUsage(parsedEvent.message.usage),
          )
        } else if (parsedEvent?.type === "message_delta") {
          usage = mergeAnthropicUsage(
            usage,
            normalizeAnthropicUsage(parsedEvent.usage),
          )
        }
        await stream.writeSSE({
          event: eventName,
          data,
        })
      }

      recordUsage(usage)
    })
  }

  debugJsonTail(logger, "Non-streaming Messages result:", {
    value: response,
    tailLength: 400,
  })
  recordUsage(normalizeAnthropicUsage(response.usage))
  return c.json(response)
}

export const prepareCopilotChatCompletionsPayload = (
  payload: ChatCompletionsPayload,
): void => {
  applyCopilotContextCache(payload)
}

const applyCopilotContextCache = (payload: ChatCompletionsPayload): void => {
  const messageIndexes = selectCopilotContextCacheMessageIndexes(
    payload.messages,
  )
  for (const messageIndex of messageIndexes) {
    const message = payload.messages[messageIndex]
    message.copilot_cache_control = { ...COPILOT_CONTEXT_CACHE_CONTROL }
  }
}

const selectCopilotContextCacheMessageIndexes = (
  messages: Array<Message>,
): Array<number> => {
  const systemIndexes = messages
    .flatMap((message, index) =>
      message.role === "system" && isCopilotContextCacheEligible(message) ?
        [index]
      : [],
    )
    .slice(0, COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT)
  const reverseNonSystemIndexes = messages
    .flatMap((message, index) =>
      message.role !== "system" && isCopilotContextCacheEligible(message) ?
        [index]
      : [],
    )
    .reverse()
    .slice(0, COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT)

  return uniqueIndexes([...systemIndexes, ...reverseNonSystemIndexes]).sort(
    (a, b) => a - b,
  )
}

const isCopilotContextCacheEligible = (message: Message): boolean => {
  if (typeof message.content === "string") {
    return message.content.length > 0
  }

  return Array.isArray(message.content) && message.content.length > 0
}

const uniqueIndexes = (indexes: Array<number>): Array<number> => [
  ...new Set(indexes),
]

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createCopilotChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const createCopilotUsageRecorder = (options: {
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string
  model: string
  payload: AnthropicMessagesPayload
}): ((usage: UsageTokens) => void) =>
  createCopilotTokenUsageRecorder({
    endpoint: options.endpoint,
    fallbackSessionId: options.fallbackSessionId,
    model: options.model,
    sessionId: getMetadataSessionId(options.payload),
  })

const getMetadataSessionId = (
  payload: AnthropicMessagesPayload,
): string | null => parseUserIdMetadata(payload.metadata?.user_id).sessionId

const parseAnthropicStreamEvent = (
  data: string,
): AnthropicStreamEventData | null => {
  try {
    return JSON.parse(data) as AnthropicStreamEventData
  } catch {
    return null
  }
}
