import type { Context, Env } from "hono"

import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicStreamState,
} from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponsesResult,
  ResponseStreamEvent,
  ResponsesStream,
} from "~/services/copilot/create-responses"

import { type ModelConfig, type ResolvedProviderConfig } from "~/lib/config"
import { logCodexRateLimitsEvent } from "~/lib/codex-rate-limit"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger, debugJson, debugLazy } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { resolveBridgeToolSearchName } from "~/lib/tool-search"
import {
  createProviderTokenUsageRecorder,
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { parseUserIdMetadata } from "~/lib/utils"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "~/routes/messages/non-stream-translation"
import {
  flushPendingAnthropicStreamEvents,
  translateChunkToAnthropicEvents,
} from "~/routes/messages/stream-translation"
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
  buildSyntheticStreamEvents,
  collectWebSearchResponsesStreamResult,
  hasWebSearchServerTool,
  isWebSearchOnlyRequest,
  prepareWebSearchResponsesPayload,
  reconstructWebSearchResponse,
  stripWebSearchServerTool,
} from "~/routes/messages/web-search/fulfill"
import { normalizeSystemMessages } from "~/routes/messages/preprocess"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
} from "~/routes/responses/utils"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import { forwardCodexResponses } from "~/services/codex/create-responses"
import {
  forwardProviderChatCompletions,
  forwardProviderMessages,
  forwardProviderResponses,
} from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("provider-messages-handler")

const OPENAI_COMPATIBLE_CONTEXT_CACHE_MARKER_LIMIT = 4
const OPENAI_COMPATIBLE_CONTEXT_CACHE_CONTROL = {
  type: "ephemeral",
} as const
const OPENAI_COMPATIBLE_CONTEXT_CACHE_ROLES = new Set<Message["role"]>([
  "system",
  "user",
  "assistant",
  "tool",
])

export async function handleProviderMessages(
  c: Context<Env, "/:provider">,
): Promise<Response> {
  const provider = c.req.param("provider")
  const payload = await c.req.json<AnthropicMessagesPayload>()
  return await handleProviderMessagesForProvider(c, { payload, provider })
}

export async function handleProviderMessagesForProvider(
  c: Context,
  options: {
    payload: AnthropicMessagesPayload
    provider: string
  },
): Promise<Response> {
  const { payload, provider } = options
  const providerConfig = await resolveProviderConfig(provider)
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
    const modelConfig = providerConfig.models?.[payload.model]
    debugJson(logger, "provider.messages.request", { payload, provider })

    normalizeSystemMessages(payload)

    applyModelDefaults(payload, modelConfig)

    if (providerConfig.type === "openai-responses") {
      if (hasWebSearchServerTool(payload)) {
        if (isWebSearchOnlyRequest(payload)) {
          return await handleOpenAIResponsesProviderWebSearchMessages(c, {
            payload,
            provider,
            providerConfig,
          })
        }

        stripWebSearchServerTool(payload)
      }

      return await handleOpenAIResponsesProviderMessages(c, {
        modelConfig,
        payload,
        provider,
        providerConfig,
      })
    }

    if (providerConfig.type === "openai-compatible") {
      stripWebSearchServerTool(payload)

      return await handleOpenAICompatibleProviderMessages(c, {
        modelConfig,
        payload,
        provider,
        providerConfig,
      })
    }

    applyMissingExtraBody(payload as unknown as Record<string, unknown>, {
      extraBody: modelConfig?.extraBody,
    })

    debugJson(logger, "Translated provider.messages.request", {
      payload,
      provider,
    })
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
      return streamProviderMessages({
        c,
        payload,
        provider,
        providerConfig,
        upstreamResponse,
      })
    }

    const jsonBody = (await upstreamResponse.json()) as AnthropicResponse
    return respondProviderMessagesJson(c, {
      body: jsonBody,
      payload,
      provider,
      providerConfig,
    })
  } catch (error) {
    logger.error("provider.messages.error", {
      provider,
      error,
    })
    throw error
  }
}

const handleOpenAIResponsesProviderWebSearchMessages = async (
  c: Context,
  options: {
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
  },
): Promise<Response> => {
  const { payload, provider, providerConfig } = options
  const selectedModel =
    providerConfig.name === "codex" ?
      getCodexModels().data.find((model) => model.id === payload.model)
    : undefined
  const responsesPayload = prepareWebSearchResponsesPayload(payload)
  responsesPayload.stream = true

  applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )
  compactInputByLatestCompaction(responsesPayload)

  debugJson(logger, "provider.messages.responses.web_search.request", {
    payload: responsesPayload,
    provider,
  })

  if (providerConfig.name === "codex") {
    const upstreamResponse = await forwardCodexResponses(
      responsesPayload,
      c.req.raw.headers,
      providerConfig.baseUrl,
    )

    if (isResponsesStream(upstreamResponse)) {
      const body = await collectWebSearchResponsesStreamResult({
        errorMessagePrefix: `${provider} web search responses stream`,
        parseEvent: (data) =>
          parseResponsesProviderStreamChunk(data, providerConfig),
        upstreamResponse,
        logger,
      })
      return respondWebSearchProviderMessagesJson(c, {
        body,
        payload,
        provider,
      })
    }

    return respondWebSearchProviderMessagesJson(c, {
      body: upstreamResponse,
      payload,
      provider,
    })
  }

  const upstreamResponse = await forwardProviderResponses(
    providerConfig,
    responsesPayload,
    c.req.raw.headers,
  )

  if (!upstreamResponse.ok) {
    logger.error("Failed to create provider web search responses", {
      provider,
      upstreamResponse,
    })
    throw new HTTPError(
      "Failed to create provider web search responses",
      upstreamResponse,
    )
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? ""
  if (contentType.includes("text/event-stream")) {
    const body = await collectWebSearchResponsesStreamResult({
      errorMessagePrefix: `${provider} web search responses stream`,
      parseEvent: (data) =>
        parseResponsesProviderStreamChunk(data, providerConfig),
      upstreamResponse: events(upstreamResponse),
      logger,
    })
    return respondWebSearchProviderMessagesJson(c, {
      body,
      payload,
      provider,
    })
  }

  const jsonBody = (await upstreamResponse.json()) as ResponsesResult
  return respondWebSearchProviderMessagesJson(c, {
    body: jsonBody,
    payload,
    provider,
  })
}

const handleOpenAIResponsesProviderMessages = async (
  c: Context,
  options: {
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
  },
): Promise<Response> => {
  const { payload, provider, providerConfig } = options
  const selectedModel =
    providerConfig.name === "codex" ?
      getCodexModels().data.find((model) => model.id === payload.model)
    : undefined
  const responsesPayload = translateAnthropicMessagesToResponsesPayload(payload)

  applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )
  compactInputByLatestCompaction(responsesPayload)

  debugJson(logger, "provider.messages.responses.request", {
    payload: responsesPayload,
    provider,
  })

  if (providerConfig.name === "codex") {
    const upstreamResponse = await forwardCodexResponses(
      responsesPayload,
      c.req.raw.headers,
      providerConfig.baseUrl,
    )

    if (responsesPayload.stream && isResponsesStream(upstreamResponse)) {
      return streamResponsesProviderMessages({
        c,
        payload,
        provider,
        providerConfig,
        upstreamResponse,
      })
    }

    return respondResponsesProviderMessagesJson(c, {
      body: upstreamResponse as ResponsesResult,
      payload,
      provider,
      providerConfig,
    })
  }

  const upstreamResponse = await forwardProviderResponses(
    providerConfig,
    responsesPayload,
    c.req.raw.headers,
  )

  if (!upstreamResponse.ok) {
    logger.error("Failed to create provider responses", upstreamResponse)
    throw new HTTPError("Failed to create provider responses", upstreamResponse)
  }

  if (responsesPayload.stream) {
    return streamResponsesProviderMessages({
      c,
      payload,
      provider,
      providerConfig,
      upstreamResponse: events(upstreamResponse),
    })
  }

  const jsonBody = (await upstreamResponse.json()) as ResponsesResult
  return respondResponsesProviderMessagesJson(c, {
    body: jsonBody,
    payload,
    provider,
    providerConfig,
  })
}

const applyModelDefaults = (
  payload: AnthropicMessagesPayload,
  modelConfig: ModelConfig | undefined,
): void => {
  payload.temperature ??= modelConfig?.temperature
  payload.top_p ??= modelConfig?.topP
  payload.top_k ??= modelConfig?.topK
}

const applyMissingExtraBody = (
  payload: Record<string, unknown>,
  options: { extraBody: Record<string, unknown> | undefined },
): void => {
  for (const [key, value] of Object.entries(options.extraBody ?? {})) {
    if (!Object.hasOwn(payload, key)) {
      payload[key] = value
    }
  }
}

const getRequestThinkingBudget = (
  payload: AnthropicMessagesPayload,
): number | undefined => {
  const budget = payload.thinking?.budget_tokens
  if (typeof budget !== "number" || !Number.isFinite(budget)) {
    return undefined
  }
  return budget
}

const applyOpenAICompatibleThinkingBudget = (
  payload: ChatCompletionsPayload,
  source: AnthropicMessagesPayload,
): void => {
  const thinkingBudget = getRequestThinkingBudget(source)
  if (thinkingBudget !== undefined) {
    payload.thinking_budget = thinkingBudget
    return
  }

  if (payload.thinking_budget === undefined) {
    delete payload.thinking_budget
  }
}

const applyOpenAICompatibleExtraBodyThinkingBudget = (
  payload: ChatCompletionsPayload,
  options: { extraBody: Record<string, unknown> | undefined },
): void => {
  const { extraBody } = options
  if (!extraBody || !Object.hasOwn(extraBody, "thinking_budget")) {
    return
  }

  const rawPayload = payload as Record<string, unknown>
  rawPayload.thinking_budget = extraBody.thinking_budget
}

const handleOpenAICompatibleProviderMessages = async (
  c: Context,
  options: {
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
  },
): Promise<Response> => {
  const { modelConfig, payload, provider, providerConfig } = options
  const openAIPayload = createOpenAICompatiblePayload(payload, modelConfig)
  debugJson(logger, "provider.messages.openai_compatible.request", {
    payload: openAIPayload,
    provider,
  })

  const upstreamResponse = await forwardProviderChatCompletions(
    providerConfig,
    openAIPayload,
    c.req.raw.headers,
  )

  if (!upstreamResponse.ok) {
    logger.error(
      "Failed to create openai-compatible responses",
      upstreamResponse,
    )
    throw new HTTPError(
      "Failed to create openai-compatible responses",
      upstreamResponse,
    )
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? ""
  const isStreamingResponse =
    Boolean(openAIPayload.stream) && contentType.includes("text/event-stream")

  if (isStreamingResponse) {
    return streamOpenAICompatibleProviderMessages({
      c,
      payload,
      provider,
      upstreamResponse,
    })
  }

  const jsonBody = (await upstreamResponse.json()) as ChatCompletionResponse
  return respondOpenAICompatibleProviderMessagesJson(c, {
    body: jsonBody,
    payload,
    provider,
  })
}

const createOpenAICompatiblePayload = (
  payload: AnthropicMessagesPayload,
  modelConfig: ModelConfig | undefined,
): ChatCompletionsPayload => {
  const openAIPayload = translateToOpenAI(payload, {
    supportPdf: modelConfig?.supportPdf,
    toolContentSupportType: modelConfig?.toolContentSupportType ?? [],
  })
  applyOpenAICompatibleThinkingBudget(openAIPayload, payload)

  if (payload.top_k !== undefined) {
    openAIPayload.top_k = payload.top_k
  }

  if (openAIPayload.stream) {
    openAIPayload.stream_options = {
      include_usage: true,
    }
  }

  normalizeOpenAICompatibleReasoningContent(openAIPayload)

  applyOpenAICompatibleRequestOverrides(openAIPayload, {
    extraBody: modelConfig?.extraBody,
    source: payload as unknown as Record<string, unknown>,
  })

  applyMissingExtraBody(openAIPayload, {
    extraBody: modelConfig?.extraBody,
  })

  applyOpenAICompatibleExtraBodyThinkingBudget(openAIPayload, {
    extraBody: modelConfig?.extraBody,
  })

  if (!Object.hasOwn(openAIPayload, "parallel_tool_calls")) {
    openAIPayload.parallel_tool_calls = true
  }

  if (modelConfig?.contextCache !== false) {
    applyOpenAICompatibleContextCache(openAIPayload)
  }

  return openAIPayload
}

const normalizeOpenAICompatibleReasoningContent = (
  payload: ChatCompletionsPayload,
): void => {
  for (const message of payload.messages) {
    if (message.role !== "assistant") {
      continue
    }

    if (
      message.reasoning_content === undefined
      && message.reasoning_text !== undefined
    ) {
      message.reasoning_content = message.reasoning_text
    }

    delete message.reasoning_text
    delete message.reasoning_opaque
  }
}

const applyOpenAICompatibleRequestOverrides = (
  payload: ChatCompletionsPayload,
  options: {
    extraBody: Record<string, unknown> | undefined
    source: Record<string, unknown>
  },
): void => {
  const allowedKeys = new Set(Object.keys(options.extraBody ?? {}))
  for (const key of allowedKeys) {
    if (Object.hasOwn(options.source, key)) {
      payload[key] = options.source[key]
    }
  }
}

const applyOpenAICompatibleContextCache = (
  payload: ChatCompletionsPayload,
): void => {
  const messageIndexes = selectContextCacheMessageIndexes(payload.messages)
  for (const messageIndex of messageIndexes) {
    applyContextCacheControl(payload.messages[messageIndex])
  }
}

const selectContextCacheMessageIndexes = (
  messages: Array<Message>,
): Array<number> => {
  const cacheableIndexes = messages.flatMap((message, index) =>
    isContextCacheMarkerEligible(message) ? [index] : [],
  )
  const systemIndexes = cacheableIndexes
    .filter((index) => messages[index]?.role === "system")
    .slice(0, 2)
  const finalIndexes = cacheableIndexes
    .filter((index) => messages[index]?.role !== "system")
    .slice(-2)
  return uniqueIndexes([...systemIndexes, ...finalIndexes]).sort(
    (a, b) => a - b,
  )
}

const uniqueIndexes = (indexes: Array<number>): Array<number> =>
  [...new Set(indexes)].slice(0, OPENAI_COMPATIBLE_CONTEXT_CACHE_MARKER_LIMIT)

const isContextCacheMarkerEligible = (message: Message): boolean => {
  if (!OPENAI_COMPATIBLE_CONTEXT_CACHE_ROLES.has(message.role)) {
    return false
  }

  if (typeof message.content === "string") {
    return message.content.length > 0
  }

  return Array.isArray(message.content) && message.content.length > 0
}

const applyContextCacheControl = (message: Message | undefined): void => {
  if (!message) {
    return
  }

  if (typeof message.content === "string") {
    message.content = [
      {
        type: "text",
        text: message.content,
        cache_control: { ...OPENAI_COMPATIBLE_CONTEXT_CACHE_CONTROL },
      },
    ]
    return
  }

  if (!Array.isArray(message.content)) {
    return
  }

  const lastPart = message.content.at(-1)
  if (!lastPart) {
    return
  }
  setContextCacheControl(lastPart)
}

const setContextCacheControl = (part: ContentPart): void => {
  part.cache_control = { ...OPENAI_COMPATIBLE_CONTEXT_CACHE_CONTROL }
}

const streamProviderMessages = ({
  c,
  payload,
  provider,
  providerConfig,
  upstreamResponse,
}: {
  c: Context
  payload: AnthropicMessagesPayload
  provider: string
  providerConfig: ResolvedProviderConfig
  upstreamResponse: Response
}): Response => {
  logger.debug("provider.messages.streaming")
  const recordUsage = createProviderMessagesUsageRecorder(payload, provider)
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}

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

      const parsed = parseProviderStreamEvent(data, providerConfig)
      if (parsed) {
        usage = mergeAnthropicUsage(usage, parsed.usage)
        data = parsed.data
      }

      await stream.writeSSE({
        event: eventName,
        data,
      })
    }

    recordUsage(usage)
  })
}

const streamOpenAICompatibleProviderMessages = ({
  c,
  payload,
  provider,
  upstreamResponse,
}: {
  c: Context
  payload: AnthropicMessagesPayload
  provider: string
  upstreamResponse: Response
}): Response => {
  logger.debug("provider.messages.openai_compatible.streaming")
  const recordUsage = createProviderMessagesUsageRecorder(payload, provider)
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }

    for await (const chunk of events(upstreamResponse)) {
      logger.debug(
        "provider.messages.openai_compatible.raw_stream_event:",
        chunk.data,
      )
      const eventName = chunk.event
      if (eventName === "ping") {
        await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
        continue
      }

      if (!chunk.data || chunk.data === "[DONE]") {
        if (chunk.data === "[DONE]") {
          break
        }
        continue
      }

      const parsed = parseOpenAICompatibleStreamChunk(chunk.data)
      if (!parsed) {
        continue
      }

      if (parsed.usage) {
        usage = normalizeOpenAIUsage(parsed.usage)
      }

      const events = translateChunkToAnthropicEvents(parsed, streamState)
      for (const event of events) {
        const eventData = JSON.stringify(event)
        debugLazy(logger, () => [
          "provider.messages.openai_compatible.translated_event:",
          eventData,
        ])
        await stream.writeSSE({
          event: event.type,
          data: eventData,
        })
      }
    }

    for (const event of flushPendingAnthropicStreamEvents(streamState)) {
      const eventData = JSON.stringify(event)
      debugLazy(logger, () => [
        "provider.messages.openai_compatible.translated_event:",
        eventData,
      ])
      await stream.writeSSE({
        event: event.type,
        data: eventData,
      })
    }

    recordUsage(usage)
  })
}

const streamResponsesProviderMessages = ({
  c,
  payload,
  provider,
  providerConfig,
  upstreamResponse,
}: {
  c: Context
  payload: AnthropicMessagesPayload
  provider: string
  providerConfig: ResolvedProviderConfig
  upstreamResponse: ResponsesStream
}): Response => {
  logger.debug("provider.messages.responses.streaming", {
    provider,
  })
  const recordUsage = createProviderMessagesUsageRecorder(payload, provider)
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    const streamState = createResponsesStreamState({
      toolSearchName: resolveBridgeToolSearchName(payload.tools),
    })

    for await (const chunk of upstreamResponse) {
      logger.debug("provider.messages.responses.raw_stream_event:", chunk.data)
      const eventName = chunk.event
      if (eventName === "ping") {
        await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
        continue
      }

      if (!chunk.data || chunk.data === "[DONE]") {
        if (chunk.data === "[DONE]") {
          break
        }
        continue
      }

      const parsed = parseResponsesProviderStreamChunk(
        chunk.data,
        providerConfig,
      )
      if (!parsed) {
        continue
      }

      if (
        parsed.type === "response.completed"
        || parsed.type === "response.failed"
        || parsed.type === "response.incomplete"
      ) {
        usage = normalizeResponsesUsage(parsed.response.usage)
      }

      const events = translateResponsesStreamEvent(parsed, streamState)
      for (const event of events) {
        const eventData = JSON.stringify(event)
        debugLazy(logger, () => [
          "provider.messages.responses.translated_event:",
          eventData,
        ])
        await stream.writeSSE({
          event: event.type,
          data: eventData,
        })
      }
    }

    if (!streamState.messageCompleted) {
      const errorEvent = buildErrorEvent(
        `${provider} stream ended without a completion event`,
      )
      await stream.writeSSE({
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      })
    }

    recordUsage(usage)
  })
}

const isResponsesStream = (value: unknown): value is ResponsesStream => {
  return (
    Boolean(value)
    && typeof (value as ResponsesStream)[Symbol.asyncIterator] === "function"
  )
}

const parseOpenAICompatibleStreamChunk = (
  data: string,
): ChatCompletionChunk | null => {
  try {
    return JSON.parse(data) as ChatCompletionChunk
  } catch (error) {
    logger.error("provider.messages.openai_compatible.parse_chunk_error", {
      data,
      error,
    })
    return null
  }
}

const parseResponsesProviderStreamChunk = (
  data: string,
  providerConfig: ResolvedProviderConfig,
): ResponseStreamEvent | null => {
  try {
    const parsed = JSON.parse(data) as ResponseStreamEvent
    if (providerConfig.name === "codex") {
      logCodexRateLimitsEvent(parsed)
    }

    return parsed
  } catch (error) {
    logger.error("provider.messages.responses.parse_chunk_error", {
      provider: providerConfig.name,
      data,
      error,
    })
    return null
  }
}

const parseProviderStreamEvent = (
  data: string,
  providerConfig: ResolvedProviderConfig,
): { data: string; model?: string; usage: UsageTokens } | null => {
  try {
    const parsed = JSON.parse(data) as AnthropicStreamEventData
    if (parsed.type === "message_start") {
      adjustInputTokens(providerConfig, parsed.message.usage)
      return {
        data: JSON.stringify(parsed),
        model: parsed.message.model,
        usage: normalizeAnthropicUsage(parsed.message.usage),
      }
    }
    if (parsed.type === "message_delta") {
      adjustInputTokens(providerConfig, parsed.usage)
      return {
        data: JSON.stringify(parsed),
        usage: normalizeAnthropicUsage(parsed.usage),
      }
    }
    return { data: JSON.stringify(parsed), usage: {} }
  } catch (error) {
    logger.error("provider.messages.streaming.adjust_tokens_error", {
      error,
      originalData: data,
    })
    return null
  }
}

const respondProviderMessagesJson = (
  c: Context,
  options: {
    body: AnthropicResponse
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
  },
): Response => {
  const { body, payload, provider, providerConfig } = options
  const recordUsage = createProviderMessagesUsageRecorder(payload, provider)
  adjustInputTokens(providerConfig, body.usage)
  recordUsage(normalizeAnthropicUsage(body.usage))

  debugJson(logger, "provider.messages.no_stream result:", body)
  return c.json(body)
}

const respondOpenAICompatibleProviderMessagesJson = (
  c: Context,
  options: {
    body: ChatCompletionResponse
    payload: AnthropicMessagesPayload
    provider: string
  },
): Response => {
  const { body, payload, provider } = options
  const recordUsage = createProviderMessagesUsageRecorder(payload, provider)
  recordUsage(normalizeOpenAIUsage(body.usage))

  const anthropicResponse = translateToAnthropic(body)
  debugJson(
    logger,
    "provider.messages.openai_compatible.no_stream result:",
    anthropicResponse,
  )
  return c.json(anthropicResponse)
}

const respondResponsesProviderMessagesJson = (
  c: Context,
  options: {
    body: ResponsesResult
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
  },
): Response => {
  const { body, payload, provider, providerConfig } = options
  const recordUsage = createProviderMessagesUsageRecorder(payload, provider)
  recordUsage(normalizeResponsesUsage(body.usage))

  const anthropicResponse = translateResponsesResultToAnthropic(body, {
    toolSearchName: resolveBridgeToolSearchName(payload.tools),
  })
  debugJson(
    logger,
    "provider.messages.responses.no_stream result:",
    anthropicResponse,
  )

  if (providerConfig.name === "codex") {
    logger.debug("provider.messages.codex.no_stream.result")
  }
  return c.json(anthropicResponse)
}

const respondWebSearchProviderMessagesJson = (
  c: Context,
  options: {
    body: ResponsesResult
    payload: AnthropicMessagesPayload
    provider: string
  },
): Response => {
  const { body, payload, provider } = options
  const recordUsage = createProviderMessagesUsageRecorder(payload, provider)
  recordUsage(normalizeResponsesUsage(body.usage))

  const { extract, response } = reconstructWebSearchResponse(payload, body, {
    requestId: body.id || `${provider}:${payload.model}`,
  })
  logger.debug(
    `provider.messages.responses.web_search: ${extract.queries.length} quer(y/ies), ${extract.sources.length} source(s)`,
  )

  if (!payload.stream) {
    return c.json(response)
  }

  return streamSSE(c, async (stream) => {
    for (const event of buildSyntheticStreamEvents(response)) {
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      })
    }
  })
}

const createProviderMessagesUsageRecorder = (
  payload: AnthropicMessagesPayload,
  provider: string,
) =>
  createProviderTokenUsageRecorder({
    endpoint: "provider_messages",
    model: payload.model,
    providerName: provider,
    sessionId: parseUserIdMetadata(payload.metadata?.user_id).sessionId,
  })

const adjustInputTokens = (
  providerConfig: ResolvedProviderConfig,
  usage?: {
    input_tokens?: number
    cache_read_input_tokens?: number
  },
): void => {
  if (!providerConfig.adjustInputTokens || !usage) {
    return
  }
  const adjustedInput = Math.max(
    0,
    (usage.input_tokens ?? 0) - (usage.cache_read_input_tokens ?? 0),
  )
  usage.input_tokens = adjustedInput
  debugJson(logger, "provider.messages.adjusted_usage:", usage)
}
