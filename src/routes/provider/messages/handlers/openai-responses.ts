import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"

import type {
  ResponsesResult,
  ResponseStreamEvent,
  ResponsesStream,
} from "~/lib/types/responses"

import { type ModelConfig, type ResolvedProviderConfig } from "~/lib/config"
import { logCodexRateLimitsEvent } from "~/lib/codex-rate-limit"

import { HTTPError } from "~/lib/error"
import { recordResponsesFirstToken } from "~/lib/first-token"
import { debugJson, debugLazy } from "~/lib/logger"
import { writeSSEIfConnected } from "~/lib/sse"
import { resolveBridgeToolSearchName } from "~/lib/tool-search"
import {
  normalizeResponsesUsage,
  type TokenUsageEndpoint,
  type UsageTokens,
} from "~/lib/token-usage"
import { isResponsesStream } from "~/lib/utils"

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
  prepareWebSearchResponsesPayload,
  reconstructWebSearchResponse,
} from "~/routes/messages/web-search/fulfill"

import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
} from "~/routes/responses/utils"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import { forwardCodexResponses } from "~/services/codex/create-responses"
import { forwardProviderResponses } from "~/services/providers/provider-proxy"
import { createResponsesHttpEventStream } from "~/services/responses-http"
import { createResponsesSafeStream } from "~/services/responses-websocket-helpers"
import { normalizeProviderResponsesReasoningEffort } from "~/routes/provider/utils"

import { logger } from "./log"
import { createProviderMessagesUsageRecorder } from "./usage"

export const handleOpenAIResponsesProviderWebSearchMessages = async (
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
  const normalizedReasoningEffort = normalizeProviderResponsesReasoningEffort(
    responsesPayload,
    providerConfig,
  )
  if (normalizedReasoningEffort) {
    logger.debug(
      `Normalized reasoning effort from ${normalizedReasoningEffort.from} to ${normalizedReasoningEffort.to} based on the provider model configuration`,
    )
  }

  debugJson(logger, "provider.messages.responses.web_search.request", {
    payload: responsesPayload,
    provider,
  })

  if (providerConfig.name === "codex") {
    const upstreamResponse = await forwardCodexResponses(
      responsesPayload,
      c.req.raw.headers,
      providerConfig.baseUrl,
      { clientSignal: c.req.raw.signal },
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
    { clientSignal: c.req.raw.signal },
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
      upstreamResponse: createResponsesHttpEventStream(upstreamResponse),
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

export const handleOpenAIResponsesProviderMessages = async (
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
  const normalizedMessagesReasoningEffort =
    normalizeProviderResponsesReasoningEffort(responsesPayload, providerConfig)
  if (normalizedMessagesReasoningEffort) {
    logger.debug(
      `Normalized reasoning effort from ${normalizedMessagesReasoningEffort.from} to ${normalizedMessagesReasoningEffort.to} based on the provider model configuration`,
    )
  }

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
      { clientSignal: c.req.raw.signal },
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
    { clientSignal: c.req.raw.signal },
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
      upstreamResponse: createResponsesSafeStream(
        createResponsesHttpEventStream(upstreamResponse),
      ),
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

export const streamResponsesProviderMessages = ({
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
        await writeSSEIfConnected(stream, {
          event: "ping",
          data: '{"type":"ping"}',
        })
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
      recordResponsesFirstToken(parsed)
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
        await writeSSEIfConnected(stream, {
          event: event.type,
          data: eventData,
        })
      }
    }

    if (!streamState.messageCompleted) {
      const errorEvent = buildErrorEvent(
        `${provider} stream ended without a completion event, retry your request.`,
      )
      await writeSSEIfConnected(stream, {
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      })
    }

    recordUsage(usage)
  })
}

export const parseResponsesProviderStreamChunk = (
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

export const respondResponsesProviderMessagesJson = (
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

export const respondWebSearchProviderMessagesJson = (
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
      await writeSSEIfConnected(stream, {
        event: event.type,
        data: data,
      })
    }
  })
}
