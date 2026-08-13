import type { Context, Env } from "hono"

import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicStreamState,
} from "~/lib/types/anthropic"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/lib/types/chat-completions"
import type {
  ResponsesResult,
  ResponseStreamEvent,
  ResponsesStream,
} from "~/lib/types/responses"

import {
  type ModelConfig,
  type ResolvedProviderConfig,
  getClaudeAutoModel,
  resolveEffectiveProviderType,
  resolveProviderAuthType,
} from "~/lib/config"
import { logCodexRateLimitsEvent } from "~/lib/codex-rate-limit"
import {
  applyDashScopePreserveThinkingDefault,
  applyOpenAICompatibleContextCache,
  isDashScopeAliyunProvider,
} from "~/lib/dashscope"
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
  type TokenUsageEndpoint,
  type UsageTokens,
} from "~/lib/token-usage"
import { isResponsesStream, parseUserIdMetadata } from "~/lib/utils"
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
import { collectResponsesStreamResult } from "~/routes/messages/responses-stream-collection"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import {
  buildSyntheticStreamEvents,
  hasWebSearchServerTool,
  isWebSearchOnlyRequest,
  prepareWebSearchResponsesPayload,
  reconstructWebSearchResponse,
  stripWebSearchServerTool,
} from "~/routes/messages/web-search/fulfill"
import {
  isClaudeAutoModelRequest,
  normalizeSystemMessages,
} from "~/routes/messages/preprocess"
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
import {
  applyMissingExtraBody,
  applyModelDefaults,
} from "~/routes/provider/utils"
import consola from "consola"

const logger = createHandlerLogger("provider-messages-handler")

export const providerMessagesHandlerDependencies = {
  resolveProviderConfig,
}

export async function handleProviderMessages(
  c: Context<Env, "/:provider">,
): Promise<Response> {
  const provider = c.req.param("provider")
  const payload = await c.req.json<AnthropicMessagesPayload>()

  const claudeAutoModel = getClaudeAutoModel()
  if (claudeAutoModel && isClaudeAutoModelRequest(payload)) {
    consola.debug(
      `Claude auto model override (${provider}): ${payload.model} -> ${claudeAutoModel}`,
    )
    payload.model = claudeAutoModel
  }

  return await handleProviderMessagesForProvider(c, {
    payload,
    provider,
  })
}

export async function handleProviderMessagesForProvider(
  c: Context,
  options: {
    payload: AnthropicMessagesPayload
    provider: string
    usageEndpoint?: TokenUsageEndpoint
  },
): Promise<Response> {
  const { payload, provider, usageEndpoint } = options
  const providerConfig =
    await providerMessagesHandlerDependencies.resolveProviderConfig(provider)
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
    const effectiveType = resolveEffectiveProviderType(
      providerConfig,
      payload.model,
    )
    debugJson(logger, "provider.messages.request", { payload, provider })

    normalizeSystemMessages(payload)

    applyModelDefaults(payload, modelConfig)

    if (effectiveType === "openai-responses") {
      if (hasWebSearchServerTool(payload)) {
        if (isWebSearchOnlyRequest(payload)) {
          return await handleOpenAIResponsesProviderWebSearchMessages(c, {
            modelConfig,
            payload,
            provider,
            providerConfig,
            usageEndpoint,
          })
        }

        stripWebSearchServerTool(payload)
      }

      return await handleOpenAIResponsesProviderMessages(c, {
        modelConfig,
        payload,
        provider,
        providerConfig,
        usageEndpoint,
      })
    }

    if (effectiveType === "openai-compatible") {
      stripWebSearchServerTool(payload)

      return await handleOpenAICompatibleProviderMessages(c, {
        modelConfig,
        payload,
        provider,
        providerConfig,
        usageEndpoint,
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
      effectiveType === providerConfig.type ?
        providerConfig
      : {
          ...providerConfig,
          type: effectiveType,
          authType: resolveProviderAuthType(
            providerConfig.name,
            undefined,
            effectiveType,
          ),
        },
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
        modelConfig,
        payload,
        pricingCurrency: providerConfig.pricingCurrency,
        provider,
        upstreamResponse,
        usageEndpoint,
      })
    }

    const jsonBody = (await upstreamResponse.json()) as AnthropicResponse
    return respondProviderMessagesJson(c, {
      body: jsonBody,
      modelConfig,
      payload,
      pricingCurrency: providerConfig.pricingCurrency,
      provider,
      usageEndpoint,
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
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
    usageEndpoint?: TokenUsageEndpoint
  },
): Promise<Response> => {
  const { modelConfig, payload, provider, providerConfig, usageEndpoint } =
    options
  const responsesPayload = prepareWebSearchResponsesPayload(payload)

  debugJson(logger, "provider.messages.responses.web_search.request", {
    payload: responsesPayload,
    provider,
  })

  if (providerConfig.name === "codex") {
    const upstreamResponse = await forwardCodexResponses(
      responsesPayload,
      c.req.raw.headers,
      providerConfig.baseUrl,
      { signal: c.req.raw.signal },
    )

    if (isResponsesStream(upstreamResponse)) {
      const body = await collectResponsesStreamResult({
        errorMessagePrefix: `${provider} web search responses stream`,
        parseEvent: (data) =>
          parseResponsesProviderStreamChunk(data, providerConfig),
        upstreamResponse,
        logger,
      })
      return respondWebSearchProviderMessagesJson(c, {
        body,
        modelConfig,
        payload,
        pricingCurrency: providerConfig.pricingCurrency,
        provider,
        usageEndpoint,
      })
    }

    return respondWebSearchProviderMessagesJson(c, {
      body: upstreamResponse,
      modelConfig,
      payload,
      pricingCurrency: providerConfig.pricingCurrency,
      provider,
      usageEndpoint,
    })
  }

  const upstreamResponse = await forwardProviderResponses(
    providerConfig,
    responsesPayload,
    c.req.raw.headers,
    { signal: c.req.raw.signal },
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
    const body = await collectResponsesStreamResult({
      errorMessagePrefix: `${provider} web search responses stream`,
      parseEvent: (data) =>
        parseResponsesProviderStreamChunk(data, providerConfig),
      upstreamResponse: events(upstreamResponse),
      logger,
    })
    return respondWebSearchProviderMessagesJson(c, {
      body,
      modelConfig,
      payload,
      pricingCurrency: providerConfig.pricingCurrency,
      provider,
      usageEndpoint,
    })
  }

  const jsonBody = (await upstreamResponse.json()) as ResponsesResult
  return respondWebSearchProviderMessagesJson(c, {
    body: jsonBody,
    modelConfig,
    payload,
    pricingCurrency: providerConfig.pricingCurrency,
    provider,
    usageEndpoint,
  })
}

const handleOpenAIResponsesProviderMessages = async (
  c: Context,
  options: {
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
    usageEndpoint?: TokenUsageEndpoint
  },
): Promise<Response> => {
  const { modelConfig, payload, provider, providerConfig, usageEndpoint } =
    options
  const selectedModel =
    providerConfig.name === "codex" ?
      getCodexModels().data.find((model) => model.id === payload.model)
    : undefined
  const wantsStream = payload.stream === true
  const responsesPayload = translateAnthropicMessagesToResponsesPayload(payload)

  if (providerConfig.name === "codex" && !wantsStream) {
    responsesPayload.stream = true
  }

  const shouldCompactInput = applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
    {
      source: "messages",
    },
  )
  if (shouldCompactInput) {
    compactInputByLatestCompaction(responsesPayload)
  }

  debugJson(logger, "provider.messages.responses.request", {
    payload: responsesPayload,
    provider,
  })

  if (providerConfig.name === "codex") {
    const upstreamResponse = await forwardCodexResponses(
      responsesPayload,
      c.req.raw.headers,
      providerConfig.baseUrl,
      { signal: c.req.raw.signal },
    )

    if (isResponsesStream(upstreamResponse)) {
      if (wantsStream) {
        return streamResponsesProviderMessages({
          c,
          modelConfig,
          payload,
          pricingCurrency: providerConfig.pricingCurrency,
          provider,
          providerConfig,
          upstreamResponse,
          usageEndpoint,
        })
      }

      const body = await collectResponsesStreamResult({
        errorMessagePrefix: `${provider} messages responses stream`,
        parseEvent: (data) =>
          parseResponsesProviderStreamChunk(data, providerConfig),
        upstreamResponse,
        logger,
      })
      return respondResponsesProviderMessagesJson(c, {
        body,
        modelConfig,
        payload,
        pricingCurrency: providerConfig.pricingCurrency,
        provider,
        providerConfig,
        usageEndpoint,
      })
    }

    return respondResponsesProviderMessagesJson(c, {
      body: upstreamResponse,
      modelConfig,
      payload,
      pricingCurrency: providerConfig.pricingCurrency,
      provider,
      providerConfig,
      usageEndpoint,
    })
  }

  const upstreamResponse = await forwardProviderResponses(
    providerConfig,
    responsesPayload,
    c.req.raw.headers,
    { signal: c.req.raw.signal },
  )

  if (!upstreamResponse.ok) {
    logger.error("Failed to create provider responses", upstreamResponse)
    throw new HTTPError("Failed to create provider responses", upstreamResponse)
  }

  if (responsesPayload.stream) {
    return streamResponsesProviderMessages({
      c,
      modelConfig,
      payload,
      pricingCurrency: providerConfig.pricingCurrency,
      provider,
      providerConfig,
      upstreamResponse: events(upstreamResponse),
      usageEndpoint,
    })
  }

  const jsonBody = (await upstreamResponse.json()) as ResponsesResult
  return respondResponsesProviderMessagesJson(c, {
    body: jsonBody,
    modelConfig,
    payload,
    pricingCurrency: providerConfig.pricingCurrency,
    provider,
    providerConfig,
    usageEndpoint,
  })
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
    usageEndpoint?: TokenUsageEndpoint
  },
): Promise<Response> => {
  const { modelConfig, payload, provider, providerConfig, usageEndpoint } =
    options
  const openAIPayload = createOpenAICompatiblePayload(
    payload,
    modelConfig,
    providerConfig,
  )
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
      modelConfig,
      payload,
      pricingCurrency: providerConfig.pricingCurrency,
      provider,
      upstreamResponse,
      usageEndpoint,
    })
  }

  const jsonBody = (await upstreamResponse.json()) as ChatCompletionResponse
  return respondOpenAICompatibleProviderMessagesJson(c, {
    body: jsonBody,
    modelConfig,
    payload,
    pricingCurrency: providerConfig.pricingCurrency,
    provider,
    usageEndpoint,
  })
}

const createOpenAICompatiblePayload = (
  payload: AnthropicMessagesPayload,
  modelConfig: ModelConfig | undefined,
  providerConfig: ResolvedProviderConfig,
): ChatCompletionsPayload => {
  const openAIPayload = translateToOpenAI(payload, {
    supportPdf: modelConfig?.supportPdf,
    toolContentSupportType: modelConfig?.toolContentSupportType ?? [],
  })

  const isDashScopeProvider = isDashScopeAliyunProvider(providerConfig)

  if (isDashScopeProvider) {
    applyOpenAICompatibleThinkingBudget(openAIPayload, payload)
  } else {
    delete openAIPayload.thinking_budget
  }

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

  applyDashScopePreserveThinkingDefault(
    openAIPayload as unknown as Record<string, unknown>,
    providerConfig,
  )

  if (!Object.hasOwn(openAIPayload, "parallel_tool_calls")) {
    openAIPayload.parallel_tool_calls = true
  }

  const contextCacheEnabled = modelConfig?.contextCache ?? isDashScopeProvider
  if (contextCacheEnabled) {
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

const streamProviderMessages = ({
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
    const openRouterThinkingState: OpenRouterThinkingStreamState = {
      signedThinkingBlockIndexes: new Set<number>(),
      thinkingBlockIndexes: new Set<number>(),
    }

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

      const parsed = parseProviderStreamEvent(data)
      if (parsed) {
        usage = mergeAnthropicUsage(usage, parsed.usage)
        data = parsed.data
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
        await stream.writeSSE({
          event: streamEvent.event,
          data: streamEvent.data,
        })
      }
    }

    recordUsage(usage)
  })
}

const streamOpenAICompatibleProviderMessages = ({
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
  logger.debug("provider.messages.openai_compatible.streaming")
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
    usageEndpoint,
  )
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
  modelConfig,
  payload,
  pricingCurrency,
  provider,
  providerConfig,
  upstreamResponse,
  usageEndpoint,
}: {
  c: Context
  modelConfig: ModelConfig | undefined
  payload: AnthropicMessagesPayload
  pricingCurrency: string | undefined
  provider: string
  providerConfig: ResolvedProviderConfig
  upstreamResponse: ResponsesStream
  usageEndpoint?: TokenUsageEndpoint
}): Response => {
  logger.debug("provider.messages.responses.streaming", {
    provider,
  })
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
    usageEndpoint,
  )
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
): { data: string; model?: string; usage: UsageTokens } | null => {
  try {
    const parsed = JSON.parse(data) as AnthropicStreamEventData
    if (parsed.type === "message_start") {
      return {
        data: JSON.stringify(parsed),
        model: parsed.message.model,
        usage: normalizeAnthropicUsage(parsed.message.usage),
      }
    }
    if (parsed.type === "message_delta") {
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

const normalizeOpenRouterThinkingSignatures = (
  body: AnthropicResponse,
): void => {
  for (const block of body.content) {
    if (block.type === "thinking") {
      block.signature ??= ""
    }
  }
}

type OpenRouterThinkingStreamState = {
  signedThinkingBlockIndexes: Set<number>
  thinkingBlockIndexes: Set<number>
}

type ProviderStreamEvent = {
  data: string
  event: string | undefined
}

const normalizeOpenRouterStreamEvents = (
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

const respondProviderMessagesJson = (
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

const respondOpenAICompatibleProviderMessagesJson = (
  c: Context,
  options: {
    body: ChatCompletionResponse
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
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    pricingCurrency: string | undefined
    provider: string
    providerConfig: ResolvedProviderConfig
    usageEndpoint?: TokenUsageEndpoint
  },
): Response => {
  const {
    body,
    modelConfig,
    payload,
    pricingCurrency,
    provider,
    providerConfig,
    usageEndpoint,
  } = options
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
    usageEndpoint,
  )
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
  recordUsage(normalizeResponsesUsage(body.usage))

  const { extract, response } = reconstructWebSearchResponse(payload, body, {
    requestId: body.id || `${provider}:${payload.model}`,
  })

  debugJson(
    logger,
    `Web search via responses: ${extract.queries.length} quer(y/ies), ${extract.sources.length} source(s)`,
    body,
  )

  if (!payload.stream) {
    return c.json(response)
  }

  return streamSSE(c, async (stream) => {
    for (const event of buildSyntheticStreamEvents(response)) {
      const data = JSON.stringify(event)
      logger.debug(`Web search stream event`, data)
      await stream.writeSSE({
        event: event.type,
        data: data,
      })
    }
  })
}

const createProviderMessagesUsageRecorder = (
  payload: AnthropicMessagesPayload,
  provider: string,
  modelConfig: ModelConfig | undefined,
  pricingCurrency: string | undefined,
  endpoint: TokenUsageEndpoint = "provider_messages",
) =>
  createProviderTokenUsageRecorder({
    endpoint,
    model: payload.model,
    pricing: modelConfig?.pricing,
    pricingCurrency,
    providerName: provider,
    sessionId: parseUserIdMetadata(payload.metadata?.user_id).sessionId,
  })
