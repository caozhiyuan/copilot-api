import type { Context } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { COMPACT_REQUEST } from "~/lib/compact"
import {
  getSmallModel,
  isMessagesApiEnabled,
  resolveMappedModel,
} from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { state } from "~/lib/state"
import {
  generateRequestIdFromPayload,
  getRootSessionId,
  getUUID,
} from "~/lib/utils"
import { handleProviderMessagesForProvider } from "~/routes/provider/messages/handler"
import { getResponsesTransportForModel } from "~/routes/responses/utils"

import type { AnthropicMessagesPayload } from "./anthropic-types"
import {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
} from "./api-flows"
import {
  applyLastMessageCacheControl,
  getCompactType,
  getLastMessageContentCacheControl,
  mergeToolResultForClaude,
  normalizeSystemMessages,
  sanitizeIdeTools,
  stripToolReferenceTurnBoundary,
} from "./preprocess"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"
import { tryHandleWebSearch } from "./web-search/fulfill"
import consola from "consola"

const logger = createHandlerLogger("messages-handler")
const CLASSIFIER_SYSTEM_PROMPT_MARKER = "<classifier_system_prompt>"

const isAutoModeClassifierRequest = (
  system: AnthropicMessagesPayload["system"],
): boolean => {
  if (typeof system === "string") {
    return system.includes(CLASSIFIER_SYSTEM_PROMPT_MARKER)
  }

  return (
    system?.some((block) =>
      block.text.includes(CLASSIFIER_SYSTEM_PROMPT_MARKER),
    ) ?? false
  )
}

export const messagesFlowHandlers = {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
}

export async function handleCompletion(c: Context) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

  const requestedModel = anthropicPayload.model
  anthropicPayload.model = resolveMappedModel(anthropicPayload.model)
  if (anthropicPayload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${anthropicPayload.model}`,
    )
  }

  const webSearchResult = await tryHandleWebSearch(c, anthropicPayload, {
    logger,
    forwardToProvider: (ctx, payload, provider) =>
      handleProviderMessagesForProvider(ctx, { payload, provider }),
  })
  if (webSearchResult) return webSearchResult

  const providerModelAlias = parseProviderModelAlias(anthropicPayload.model)
  if (providerModelAlias) {
    anthropicPayload.model = providerModelAlias.model
    return await handleProviderMessagesForProvider(c, {
      payload: anthropicPayload,
      provider: providerModelAlias.provider,
    })
  }

  debugJson(logger, "Anthropic request payload:", anthropicPayload)

  normalizeSystemMessages(anthropicPayload)

  sanitizeIdeTools(anthropicPayload)

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  let sessionId = getRootSessionId(anthropicPayload, c)

  // claude code and opencode compact / auto-continue detection
  const compactType = getCompactType(anthropicPayload)

  // fix claude code 2.0.28+ warmup request consume premium request, forcing small model if no tools are used
  // set "CLAUDE_CODE_SUBAGENT_MODEL": "you small model" also can avoid this
  // Auto Mode's classifier has the same request shape, but must retain its requested model.
  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0
  if (
    anthropicBeta
    && noTools
    && !isAutoModeClassifierRequest(anthropicPayload.system)
    && compactType === 0
  ) {
    anthropicPayload.model = getSmallModel()
  }

  if (compactType) {
    logger.debug("Compact request type:", compactType)
  }

  if (!state.tokenBasedBilling) {
    const lastMessageCacheControl = getLastMessageContentCacheControl(
      anthropicPayload.messages.at(-1),
    )

    stripToolReferenceTurnBoundary(anthropicPayload)

    // Merge tool_result and text blocks into tool_result to avoid consuming premium requests
    // (caused by skill invocations, edit hooks, plan or to do reminders)
    // e.g. {"role":"user","content":[{"type":"tool_result","content":"Launching skill: xxx"},{"type":"text","text":"xxx"}]}
    // not only for claude, but also for opencode
    // compact requests still run this processing, except for the final compact message itself
    mergeToolResultForClaude(anthropicPayload, {
      skipLastMessage: compactType === COMPACT_REQUEST,
    })

    applyLastMessageCacheControl(anthropicPayload, lastMessageCacheControl)
  }

  const requestId = generateRequestIdFromPayload(anthropicPayload, sessionId)
  logger.debug("Generated request ID:", requestId)

  if (!sessionId) {
    sessionId = getUUID(requestId)
  }
  logger.debug("Extracted session ID:", sessionId)

  const selectedModel = findEndpointModel(anthropicPayload.model)
  anthropicPayload.model = selectedModel?.id ?? anthropicPayload.model

  if (shouldUseMessagesApi(selectedModel)) {
    return await messagesFlowHandlers.handleWithMessagesApi(
      c,
      anthropicPayload,
      {
        anthropicBetaHeader: anthropicBeta,
        subagentMarker,
        selectedModel,
        requestId,
        sessionId,
        compactType,
        logger,
      },
    )
  }

  if (shouldUseResponsesApi(selectedModel, compactType)) {
    return await messagesFlowHandlers.handleWithResponsesApi(
      c,
      anthropicPayload,
      {
        subagentMarker,
        selectedModel,
        requestId,
        sessionId,
        compactType,
        logger,
      },
    )
  }

  return await messagesFlowHandlers.handleWithChatCompletions(
    c,
    anthropicPayload,
    {
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      compactType,
      logger,
    },
  )
}

const MESSAGES_ENDPOINT = "/v1/messages"

const shouldUseResponsesApi = (
  selectedModel: Model | undefined,
  compactType: ReturnType<typeof getCompactType>,
): boolean => {
  return Boolean(getResponsesTransportForModel(selectedModel, { compactType }))
}

const shouldUseMessagesApi = (selectedModel: Model | undefined): boolean => {
  const useMessagesApi = isMessagesApiEnabled()
  if (!useMessagesApi) {
    return false
  }
  return (
    selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT) ?? false
  )
}
