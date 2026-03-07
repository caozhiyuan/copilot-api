import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import {
  getSmallModel,
  shouldCompactUseSmallModel,
  getReasoningEffortForModel,
} from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import { getResponsesRequestOptions } from "~/routes/responses/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicMessagesPayload,
  type AnthropicStreamEventData,
  type AnthropicStreamState,
  type AnthropicTextBlock,
  type AnthropicToolResultBlock,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"

const logger = createHandlerLogger("messages-handler")

const compactSystemPromptStart =
  "You are a helpful AI assistant tasked with summarizing conversations"

type ThinkingStreamTracker = {
  activeIndexes: Set<number>
  textCharsByIndex: Map<number, number>
  deltaCountsByIndex: Map<number, number>
  signatureCharsByIndex: Map<number, number>
}

const createThinkingStreamTracker = (): ThinkingStreamTracker => ({
  activeIndexes: new Set<number>(),
  textCharsByIndex: new Map<number, number>(),
  deltaCountsByIndex: new Map<number, number>(),
  signatureCharsByIndex: new Map<number, number>(),
})

const logThinkingTelemetry = (
  message: string,
  details?: Record<string, unknown>,
): void => {
  const serialized = details ? JSON.stringify(details) : undefined
  if (serialized) {
    logger.info("[thinking]", message, serialized)
  } else {
    logger.info("[thinking]", message)
  }

  if (!state.verbose) {
    return
  }

  if (serialized) {
    consola.info(`[thinking] ${message} ${serialized}`)
    return
  }

  consola.info(`[thinking] ${message}`)
}

const isThinkingBlock = (
  block: AnthropicAssistantContentBlock,
): block is Extract<AnthropicAssistantContentBlock, { type: "thinking" }> =>
  block.type === "thinking"

const countAssistantThinkingBlocks = (
  payload: AnthropicMessagesPayload,
): number => {
  return payload.messages.reduce((count, message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return count
    }

    return (
      count + message.content.filter((block) => isThinkingBlock(block)).length
    )
  }, 0)
}

const logThinkingRequestSummary = (
  route: "messages" | "chat-completions" | "responses",
  payload: AnthropicMessagesPayload,
  options?: {
    filteredThinkingBlocks?: number
    anthropicBetaHeader?: string
  },
): void => {
  const assistantHistoryThinkingBlocks = countAssistantThinkingBlocks(payload)
  const thinkingRequested = Boolean(payload.thinking)
  const filteredThinkingBlocks = options?.filteredThinkingBlocks ?? 0

  if (
    !thinkingRequested
    && assistantHistoryThinkingBlocks === 0
    && filteredThinkingBlocks === 0
  ) {
    return
  }

  logThinkingTelemetry(`${route} request`, {
    model: payload.model,
    stream: payload.stream ?? false,
    thinking_requested: thinkingRequested,
    thinking_type: payload.thinking?.type ?? null,
    thinking_budget_tokens: payload.thinking?.budget_tokens ?? null,
    assistant_history_thinking_blocks: assistantHistoryThinkingBlocks,
    filtered_thinking_blocks: filteredThinkingBlocks,
    anthropic_beta: options?.anthropicBetaHeader ?? null,
  })
}

const logThinkingResponseSummary = (
  route: "messages" | "chat-completions" | "responses",
  content: Array<AnthropicAssistantContentBlock>,
): void => {
  const thinkingBlocks = content.filter((block) => isThinkingBlock(block))
  if (thinkingBlocks.length === 0) {
    return
  }

  logThinkingTelemetry(`${route} response`, {
    thinking_blocks: thinkingBlocks.length,
    blocks: thinkingBlocks.map((block, index) => ({
      index,
      chars: block.thinking.length,
      signature_present: block.signature.length > 0,
    })),
  })
}

const logThinkingStreamEvent = (
  route: "messages" | "chat-completions" | "responses",
  event: AnthropicStreamEventData,
  tracker: ThinkingStreamTracker,
): void => {
  if (
    event.type === "content_block_start"
    && event.content_block.type === "thinking"
  ) {
    tracker.activeIndexes.add(event.index)
    tracker.textCharsByIndex.set(event.index, 0)
    tracker.deltaCountsByIndex.set(event.index, 0)
    tracker.signatureCharsByIndex.set(event.index, 0)
    logThinkingTelemetry(`${route} thinking block started`, {
      index: event.index,
    })
    return
  }

  if (
    event.type === "content_block_delta"
    && event.delta.type === "thinking_delta"
  ) {
    const chars = event.delta.thinking.length
    tracker.textCharsByIndex.set(
      event.index,
      (tracker.textCharsByIndex.get(event.index) ?? 0) + chars,
    )
    tracker.deltaCountsByIndex.set(
      event.index,
      (tracker.deltaCountsByIndex.get(event.index) ?? 0) + 1,
    )
    return
  }

  if (
    event.type === "content_block_delta"
    && event.delta.type === "signature_delta"
  ) {
    if (!tracker.activeIndexes.has(event.index)) {
      return
    }

    tracker.signatureCharsByIndex.set(event.index, event.delta.signature.length)
    logThinkingTelemetry(`${route} thinking signature`, {
      index: event.index,
      signature_chars: event.delta.signature.length,
    })
    return
  }

  if (
    event.type === "content_block_stop"
    && tracker.activeIndexes.has(event.index)
  ) {
    logThinkingTelemetry(`${route} thinking block stopped`, {
      index: event.index,
      delta_count: tracker.deltaCountsByIndex.get(event.index) ?? 0,
      total_chars: tracker.textCharsByIndex.get(event.index) ?? 0,
      signature_chars: tracker.signatureCharsByIndex.get(event.index) ?? 0,
    })
    tracker.activeIndexes.delete(event.index)
    tracker.textCharsByIndex.delete(event.index)
    tracker.deltaCountsByIndex.delete(event.index)
    tracker.signatureCharsByIndex.delete(event.index)
  }
}

const tryParseAnthropicStreamEvent = (
  data: string,
): AnthropicStreamEventData | undefined => {
  if (!data) {
    return undefined
  }

  try {
    return JSON.parse(data) as AnthropicStreamEventData
  } catch {
    return undefined
  }
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  logger.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  const initiatorOverride = subagentMarker ? "agent" : undefined
  if (subagentMarker) {
    logger.debug("Detected Subagent marker:", JSON.stringify(subagentMarker))
  }

  // claude code and opencode compact request detection
  const isCompact = isCompactRequest(anthropicPayload)

  // fix claude code 2.0.28+ warmup request consume premium request, forcing small model if no tools are used
  // set "CLAUDE_CODE_SUBAGENT_MODEL": "you small model" also can avoid this
  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0
  if (anthropicBeta && noTools && !isCompact) {
    anthropicPayload.model = getSmallModel()
  }

  if (isCompact) {
    logger.debug("Is compact request:", isCompact)
    if (shouldCompactUseSmallModel()) {
      anthropicPayload.model = getSmallModel()
    }
  } else {
    // Merge tool_result and text blocks into tool_result to avoid consuming premium requests
    // (caused by skill invocations, edit hooks, plan or to do reminders)
    // e.g. {"role":"user","content":[{"type":"tool_result","content":"Launching skill: xxx"},{"type":"text","text":"xxx"}]}
    // not only for claude, but also for opencode
    // compact requests are excluded from this processing
    mergeToolResultForClaude(anthropicPayload)
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  const selectedModel = state.models?.data.find(
    (m) => m.id === anthropicPayload.model,
  )

  if (shouldUseMessagesApi(selectedModel)) {
    return await handleWithMessagesApi(c, anthropicPayload, {
      anthropicBetaHeader: anthropicBeta,
      initiatorOverride,
      selectedModel,
    })
  }

  if (shouldUseResponsesApi(selectedModel)) {
    return await handleWithResponsesApi(c, anthropicPayload, initiatorOverride)
  }

  return await handleWithChatCompletions(c, anthropicPayload, initiatorOverride)
}

const RESPONSES_ENDPOINT = "/responses"
const MESSAGES_ENDPOINT = "/v1/messages"

const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  initiatorOverride?: "agent" | "user",
) => {
  const openAIPayload = translateToOpenAI(anthropicPayload)
  logThinkingRequestSummary("chat-completions", anthropicPayload)
  logger.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  const response = await createChatCompletions(openAIPayload, {
    initiator: initiatorOverride,
  })

  if (isNonStreaming(response)) {
    logger.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response),
    )
    const anthropicResponse = translateToAnthropic(response)
    logThinkingResponseSummary("chat-completions", anthropicResponse.content)
    logger.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  logger.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const thinkingTracker = createThinkingStreamTracker()
    const streamState: AnthropicStreamState = {
      currentModel: undefined,
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
      pendingChunksAfterThinking: [],
    }

    for await (const rawEvent of response) {
      logger.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        logThinkingStreamEvent("chat-completions", event, thinkingTracker)
        logger.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  initiatorOverride?: "agent" | "user",
) => {
  const responsesPayload =
    translateAnthropicMessagesToResponsesPayload(anthropicPayload)
  logThinkingRequestSummary("responses", anthropicPayload)
  logger.debug(
    "Translated Responses payload:",
    JSON.stringify(responsesPayload),
  )

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const response = await createResponses(responsesPayload, {
    vision,
    initiator: initiatorOverride ?? initiator,
  })

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return streamSSE(c, async (stream) => {
      const thinkingTracker = createThinkingStreamTracker()
      const streamState = createResponsesStreamState()

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

        logger.debug("Responses raw stream event:", data)

        const events = translateResponsesStreamEvent(
          JSON.parse(data) as ResponseStreamEvent,
          streamState,
        )
        for (const event of events) {
          const eventData = JSON.stringify(event)
          logThinkingStreamEvent("responses", event, thinkingTracker)
          logger.debug("Translated Anthropic event:", eventData)
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
    })
  }

  logger.debug(
    "Non-streaming Responses result:",
    JSON.stringify(response).slice(-400),
  )
  const anthropicResponse = translateResponsesResultToAnthropic(
    response as ResponsesResult,
  )
  logThinkingResponseSummary("responses", anthropicResponse.content)
  logger.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )
  return c.json(anthropicResponse)
}

const handleWithMessagesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    anthropicBetaHeader?: string
    initiatorOverride?: "agent" | "user"
    selectedModel?: Model
  },
) => {
  const { anthropicBetaHeader, initiatorOverride, selectedModel } =
    options ?? {}
  const thinkingBlocksBeforeFilter =
    countAssistantThinkingBlocks(anthropicPayload)
  // Pre-request processing: filter thinking blocks for Claude models so only
  // valid thinking blocks are sent to the Copilot Messages API.
  for (const msg of anthropicPayload.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      msg.content = msg.content.filter((block) => {
        if (block.type !== "thinking") return true
        return (
          block.thinking
          && block.thinking !== "Thinking..."
          && block.signature
          && !block.signature.includes("@")
        )
      })
    }
  }
  const filteredThinkingBlocks =
    thinkingBlocksBeforeFilter - countAssistantThinkingBlocks(anthropicPayload)

  if (selectedModel?.capabilities.supports.adaptive_thinking) {
    anthropicPayload.thinking = {
      type: "adaptive",
    }
    anthropicPayload.output_config = {
      effort: getAnthropicEffortForModel(anthropicPayload.model),
    }
  }

  logThinkingRequestSummary("messages", anthropicPayload, {
    filteredThinkingBlocks,
    anthropicBetaHeader,
  })

  logger.debug("Translated Messages payload:", JSON.stringify(anthropicPayload))

  const response = await createMessages(anthropicPayload, anthropicBetaHeader, {
    initiator: initiatorOverride,
  })

  if (isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Messages API)")
    return streamSSE(c, async (stream) => {
      const thinkingTracker = createThinkingStreamTracker()
      for await (const event of response) {
        const eventName = event.event
        const data = event.data ?? ""
        const parsedEvent = tryParseAnthropicStreamEvent(data)
        if (parsedEvent) {
          logThinkingStreamEvent("messages", parsedEvent, thinkingTracker)
        }
        logger.debug("Messages raw stream event:", data)
        await stream.writeSSE({
          event: eventName,
          data,
        })
      }
    })
  }

  logger.debug(
    "Non-streaming Messages result:",
    JSON.stringify(response).slice(-400),
  )
  logThinkingResponseSummary("messages", response.content)
  return c.json(response)
}

const shouldUseResponsesApi = (selectedModel: Model | undefined): boolean => {
  return (
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false
  )
}

const shouldUseMessagesApi = (selectedModel: Model | undefined): boolean => {
  return (
    selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT) ?? false
  )
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const getAnthropicEffortForModel = (
  model: string,
): "low" | "medium" | "high" | "max" => {
  const reasoningEffort = getReasoningEffortForModel(model)

  if (reasoningEffort === "xhigh") return "max"
  if (reasoningEffort === "none" || reasoningEffort === "minimal") return "low"

  return reasoningEffort
}

const isCompactRequest = (
  anthropicPayload: AnthropicMessagesPayload,
): boolean => {
  const system = anthropicPayload.system
  if (typeof system === "string") {
    return system.startsWith(compactSystemPromptStart)
  }
  if (!Array.isArray(system)) return false

  return system.some(
    (msg) =>
      typeof msg.text === "string"
      && msg.text.startsWith(compactSystemPromptStart),
  )
}

const mergeContentWithText = (
  tr: AnthropicToolResultBlock,
  textBlock: AnthropicTextBlock,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    return { ...tr, content: `${tr.content}\n\n${textBlock.text}` }
  }
  return {
    ...tr,
    content: [...tr.content, textBlock],
  }
}

const mergeContentWithTexts = (
  tr: AnthropicToolResultBlock,
  textBlocks: Array<AnthropicTextBlock>,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    const appendedTexts = textBlocks.map((tb) => tb.text).join("\n\n")
    return { ...tr, content: `${tr.content}\n\n${appendedTexts}` }
  }
  return { ...tr, content: [...tr.content, ...textBlocks] }
}

const mergeToolResultForClaude = (
  anthropicPayload: AnthropicMessagesPayload,
): void => {
  for (const msg of anthropicPayload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const toolResults: Array<AnthropicToolResultBlock> = []
    const textBlocks: Array<AnthropicTextBlock> = []
    let valid = true

    for (const block of msg.content) {
      if (block.type === "tool_result") {
        toolResults.push(block)
      } else if (block.type === "text") {
        textBlocks.push(block)
      } else {
        valid = false
        break
      }
    }

    if (!valid || toolResults.length === 0 || textBlocks.length === 0) continue

    msg.content = mergeToolResult(toolResults, textBlocks)
  }
}

const mergeToolResult = (
  toolResults: Array<AnthropicToolResultBlock>,
  textBlocks: Array<AnthropicTextBlock>,
): Array<AnthropicToolResultBlock> => {
  // equal lengths -> pairwise merge
  if (toolResults.length === textBlocks.length) {
    return toolResults.map((tr, i) => mergeContentWithText(tr, textBlocks[i]))
  }

  // lengths differ -> append all textBlocks to the last tool_result
  const lastIndex = toolResults.length - 1
  return toolResults.map((tr, i) =>
    i === lastIndex ? mergeContentWithTexts(tr, textBlocks) : tr,
  )
}
