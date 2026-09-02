import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import {
  isResponsesApiWebSearchEnabled as isConfiguredResponsesApiWebSearchEnabled,
  resolveMappedModel,
} from "~/lib/config"
import { createHandlerLogger, debugJson, debugJsonTail } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { resolveConfiguredProviderModelAlias } from "~/lib/provider-resolver"
import { isCodexUserAgent } from "~/routes/models/codex-models"
import {
  handleProviderResponsesForProvider,
  providerResponsesHandlerDependencies,
} from "~/routes/provider/responses/handler"
import {
  createCopilotTokenUsageRecorder,
  normalizeOptionalToken,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import {
  generateRequestIdFromPayload,
  getUUID,
  isAsyncIterable,
} from "~/lib/utils"
import type { SubagentMarker } from "~/lib/subagent"
import type {
  ResponsesPayload,
  ResponsesResult,
  ResponsesTransport,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import { createResponses as createCopilotResponses } from "~/services/copilot/create-responses"

import { handleResponsesViaMessages } from "./messages-handler"
import { isMessagesReasoningId } from "./messages-translation"
import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesTransportForModel,
  getResponsesRequestOptions,
  normalizeInputImageDetails,
  normalizeResponsesReasoningEffort,
  sanitizeOversizedInputImages,
  sanitizeUnsupportedInputFields,
} from "./utils"
import consola from "consola"

const logger = createHandlerLogger("responses-handler")

export const responsesHandlerDependencies = {
  createResponses: createCopilotResponses,
  findEndpointModel,
  isResponsesApiWebSearchEnabled: isConfiguredResponsesApiWebSearchEnabled,
  resolveMappedModel,
}

export const handleResponses = async (c: Context) => {
  const payload = await c.req.json<ResponsesPayload>()
  const requestedModel = payload.model
  payload.model = responsesHandlerDependencies.resolveMappedModel(payload.model)
  if (payload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }

  const providerModelAlias = await resolveConfiguredProviderModelAlias(
    payload.model,
    providerResponsesHandlerDependencies.resolveProviderConfig,
  )
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    return await handleProviderResponsesForProvider(c, {
      payload,
      provider: providerModelAlias.provider,
      publicModel: requestedModel,
    })
  }

  debugJson(logger, "Responses request payload:", payload)

  const subagentMarker = getCodexResponsesSubagentMarker(c)
  if (subagentMarker) {
    debugJson(logger, "Detected Codex subagent headers:", subagentMarker)
  }

  const incomingSessionId = getIncomingResponsesSessionId(c)
  const sessionId = incomingSessionId ? getUUID(incomingSessionId) : undefined
  const requestId = generateRequestIdFromPayload(
    { messages: payload.input },
    sessionId,
  )
  logger.debug("Generated request ID:", requestId)

  const fallbackSessionId = sessionId ?? getUUID(requestId)
  logger.debug("Extracted session ID:", fallbackSessionId)
  const selectedModel = responsesHandlerDependencies.findEndpointModel(
    payload.model,
  )
  payload.model = selectedModel?.id ?? payload.model
  const normalizedReasoningEffort = normalizeResponsesReasoningEffort(
    payload,
    selectedModel?.capabilities?.supports?.reasoning_effort,
  )
  if (normalizedReasoningEffort) {
    logger.debug(
      `Normalized reasoning effort from ${normalizedReasoningEffort.from} to ${normalizedReasoningEffort.to} based on the selected model capabilities`,
    )
  }
  const responsesTransport = getResponsesTransportForModel(selectedModel)

  const useMessagesFallback = shouldFallbackToMessages(
    c,
    payload.model,
    selectedModel,
    responsesTransport,
  )
  if (useMessagesFallback) {
    filterReasoningForTransport(payload, true)
    return await handleResponsesViaMessages(c, {
      payload,
      publicModel: requestedModel,
      targetModel: payload.model,
      subagentMarker,
      requestId,
      sessionId: fallbackSessionId,
    })
  }

  if (!responsesTransport) {
    return c.json(
      {
        error: {
          message:
            "This model does not support the responses endpoint. Please choose a different model.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  filterReasoningForTransport(payload, false)

  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "responses",
    fallbackSessionId,
    model: payload.model,
  })

  const sanitizedUnsupportedFieldCount = sanitizeUnsupportedInputFields(payload)
  if (sanitizedUnsupportedFieldCount > 0) {
    logger.debug(
      `Removed ${sanitizedUnsupportedFieldCount} unsupported input field(s) before forwarding to Copilot Responses`,
    )
  }

  const normalizedImageDetailCount = normalizeInputImageDetails(payload)
  if (normalizedImageDetailCount > 0) {
    logger.debug(
      `Normalized ${normalizedImageDetailCount} unsupported input image detail value(s) before forwarding to Copilot Responses`,
    )
  }

  removeUnsupportedTools(payload)
  fillEmptyNamespaceToolDescriptions(payload)

  if (!responsesHandlerDependencies.isResponsesApiWebSearchEnabled()) {
    removeWebSearchTool(payload)
  }

  const sanitizedImageCount = sanitizeOversizedInputImages(
    payload,
    selectedModel?.capabilities.limits.vision?.max_prompt_image_size,
  )
  if (sanitizedImageCount > 0) {
    logger.warn(
      `Omitted ${sanitizedImageCount} oversized input image(s) before forwarding to Copilot Responses`,
    )
  }

  // Smaller than the client compaction threshold, use server-side compaction to maintain cache hit rate
  const maxPromptTokens = selectedModel?.capabilities.limits.max_prompt_tokens
  const shouldCompactInput = applyResponsesApiContextManagement(
    payload,
    maxPromptTokens,
    {
      compactThresholdRatio: 0.8,
      source: "responses",
    },
  )
  if (shouldCompactInput) {
    compactInputByLatestCompaction(payload)
  }

  debugJson(logger, "Translated Responses payload:", payload)

  const { vision, initiator: inferredInitiator } =
    getResponsesRequestOptions(payload)
  const initiator = subagentMarker ? "agent" : inferredInitiator

  const response = await responsesHandlerDependencies.createResponses(payload, {
    vision,
    initiator,
    subagentMarker,
    requestId,
    sessionId: fallbackSessionId,
    signal: c.req.raw.signal,
    transport: responsesTransport,
  })

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    logger.debug("Forwarding native Responses stream")
    return streamSSE(c, async (stream) => {
      const idTracker = createStreamIdTracker()
      let usage: UsageTokens = {}
      const iterator = response[Symbol.asyncIterator]()

      try {
        for await (const chunk of {
          [Symbol.asyncIterator]: () => iterator,
        }) {
          debugJson(logger, "Responses stream chunk:", chunk)
          const parsedEvent = parseResponsesStreamEvent(chunk)
          if (
            parsedEvent?.type === "response.completed"
            || parsedEvent?.type === "response.failed"
            || parsedEvent?.type === "response.incomplete"
          ) {
            usage = {
              ...normalizeResponsesUsage(parsedEvent.response.usage),
              total_nano_aiu: normalizeOptionalToken(
                parsedEvent.copilot_usage?.total_nano_aiu,
              ),
            }
          }

          const processedData = fixStreamIds(
            (chunk as { data?: string }).data ?? "",
            (chunk as { event?: string }).event,
            idTracker,
          )

          await stream.writeSSE({
            id: (chunk as { id?: string }).id,
            event: (chunk as { event?: string }).event,
            data: processedData,
          })
        }
      } finally {
        await iterator.return?.()
        recordUsage(usage)
      }
    })
  }

  debugJsonTail(logger, "Forwarding native Responses result:", {
    value: response,
    tailLength: 400,
  })
  const result = response as ResponsesResult
  recordUsage({
    ...normalizeResponsesUsage(result.usage),
    total_nano_aiu: normalizeOptionalToken(
      result.copilot_usage?.total_nano_aiu,
    ),
  })
  return c.json(result)
}

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const filterReasoningForTransport = (
  payload: ResponsesPayload,
  useMessagesFallback: boolean,
): void => {
  if (!Array.isArray(payload.input)) return

  payload.input = payload.input.filter((item) => {
    if (item.type !== "reasoning") return true
    return isMessagesReasoningId(item.id) === useMessagesFallback
  })
}

const shouldFallbackToMessages = (
  c: Context,
  modelId: string,
  selectedModel: { supported_endpoints?: Array<string> } | undefined,
  responsesTransport: ResponsesTransport | null,
): boolean => {
  if (isCodexUserAgent(c.req.header("user-agent"))) {
    return !(modelId.startsWith("gpt") || modelId.startsWith("codex"))
  }

  if (responsesTransport) {
    return false
  }

  const supportedEndpoints = selectedModel?.supported_endpoints ?? []
  return (
    supportedEndpoints.includes("/v1/messages")
    || supportedEndpoints.includes("/chat/completions")
  )
}

const parseResponsesStreamEvent = (
  chunk: unknown,
): ResponseStreamEvent | null => {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") {
    return null
  }

  try {
    return JSON.parse(data) as ResponseStreamEvent
  } catch {
    return null
  }
}

const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}

const COPILOT_UNSUPPORTED_TOOL_TYPES = new Set(["image_generation"])
const COPILOT_UNSUPPORTED_TOOL_NAMESPACES = new Set(["image_gen"])

export const removeUnsupportedTools = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  const dropped: Array<string> = []
  payload.tools = payload.tools.filter((t) => {
    const type = t.type as string
    const name = "name" in t && typeof t.name === "string" ? t.name : undefined
    const isUnsupportedNamespace =
      type === "namespace"
      && name !== undefined
      && COPILOT_UNSUPPORTED_TOOL_NAMESPACES.has(name)
    if (COPILOT_UNSUPPORTED_TOOL_TYPES.has(type) || isUnsupportedNamespace) {
      dropped.push(isUnsupportedNamespace ? `${type}:${name}` : type)
      return false
    }
    return true
  })
  if (dropped.length > 0) {
    logger.debug("Removed unsupported tools:", dropped)
  }
}

export const fillEmptyNamespaceToolDescriptions = (
  payload: ResponsesPayload,
): void => {
  fillEmptyNamespaceDescriptions(payload.tools)

  if (!Array.isArray(payload.input)) return

  for (const item of payload.input) {
    if (!item || typeof item !== "object") continue
    fillEmptyNamespaceDescriptions((item as Record<string, unknown>).tools)
  }
}

const fillEmptyNamespaceDescriptions = (tools: unknown): void => {
  if (!Array.isArray(tools)) return

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue

    const namespaceTool = tool as Record<string, unknown>
    if (
      namespaceTool.type === "namespace"
      && namespaceTool.description === ""
      && typeof namespaceTool.name === "string"
    ) {
      namespaceTool.description = namespaceTool.name
    }
  }
}

const getIncomingResponsesSessionId = (c: Context): string | undefined =>
  getTrimmedHeader(c, "session-id") ?? getTrimmedHeader(c, "x-session-id")

const codexSubagentHeaderValues = new Set([
  "collab_spawn",
  "compact",
  "memory_consolidation",
  "review",
])

const getCodexResponsesSubagentMarker = (c: Context): SubagentMarker | null => {
  const agentType = getTrimmedHeader(c, "x-openai-subagent")
  if (!agentType || !codexSubagentHeaderValues.has(agentType)) {
    return null
  }

  const threadId = getTrimmedHeader(c, "thread-id")
  const rootSessionId = getIncomingResponsesSessionId(c)
  const parentThreadId = getTrimmedHeader(c, "x-codex-parent-thread-id")
  if (!threadId && !rootSessionId && !parentThreadId) {
    return null
  }

  const agentId = threadId ?? parentThreadId ?? rootSessionId ?? agentType

  return {
    agent_id: agentId,
    agent_type: agentType,
    session_id: threadId ?? rootSessionId ?? agentId,
  }
}

const getTrimmedHeader = (c: Context, name: string): string | undefined => {
  const value = c.req.header(name)?.trim()
  return value || undefined
}
