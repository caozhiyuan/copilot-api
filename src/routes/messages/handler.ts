import type { Context } from "hono"

import type { Model } from "~/lib/types/models"

import { COMPACT_REQUEST } from "~/lib/compact"
import {
  getClaudeAutoModel,
  getSmallModel,
  isMessagesApiEnabled,
  resolveMappedModel,
} from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { state } from "~/lib/state"
import type { SubagentMarker } from "~/lib/subagent"
import type { TokenUsageEndpoint } from "~/lib/token-usage"
import {
  generateRequestIdFromPayload,
  getRootSessionId,
  getUUID,
} from "~/lib/utils"
import {
  handleProviderMessagesForProvider,
  providerMessagesHandlerDependencies,
} from "~/routes/provider/messages/handler"
import { getResponsesTransportForModel } from "~/routes/responses/utils"

import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
} from "./api-flows"
import {
  applyLastMessageCacheControl,
  getCompactType,
  getLastMessageContentCacheControl,
  isClaudeAutoModelRequest,
  mergeToolResultForClaude,
  normalizeSystemMessages,
  sanitizeIdeTools,
  stripToolReferenceTurnBoundary,
} from "./preprocess"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"
import { tryHandleWebSearch } from "./web-search/fulfill"
import consola from "consola"

const logger = createHandlerLogger("messages-handler")

export const messagesFlowHandlers = {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
}

export async function handleCompletion(c: Context) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

  return await handleCompletionPayload(c, anthropicPayload)
}

export interface CompletionPayloadOptions {
  compactType?: ReturnType<typeof getCompactType>
  skipClaudeAutoModel?: boolean
  skipModelMapping?: boolean
  skipWebSearch?: boolean
  usageEndpoint?: TokenUsageEndpoint
  subagentMarker?: SubagentMarker | null
  sessionId?: string
  requestId?: string
}

export async function handleCompletionPayload(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  dispatchOptions: CompletionPayloadOptions = {},
) {
  const requestedModel = anthropicPayload.model
  if (!dispatchOptions.skipModelMapping) {
    anthropicPayload.model = resolveMappedModel(anthropicPayload.model)
  }
  if (anthropicPayload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${anthropicPayload.model}`,
    )
  }

  if (!dispatchOptions.skipWebSearch) {
    const webSearchResult = await tryHandleWebSearch(c, anthropicPayload, {
      logger,
      forwardToProvider: (ctx, payload, provider) =>
        handleProviderMessagesForProvider(ctx, { payload, provider }),
    })
    if (webSearchResult) return webSearchResult
  }

  const claudeAutoModel = getClaudeAutoModel()
  const shouldUseClaudeAutoModel = Boolean(
    !dispatchOptions.skipClaudeAutoModel
      && claudeAutoModel
      && isClaudeAutoModelRequest(anthropicPayload),
  )
  if (claudeAutoModel && shouldUseClaudeAutoModel) {
    consola.debug(
      `Claude auto model override: ${anthropicPayload.model} -> ${claudeAutoModel}`,
    )
    anthropicPayload.model = claudeAutoModel
  }

  const providerModelAlias = parseProviderModelAlias(anthropicPayload.model)
  if (providerModelAlias) {
    // Only treat the "/" prefix as a custom provider alias when that provider
    // is actually configured. GitHub Copilot enterprise models can ship with
    // namespaced ids such as "org/family/model" that must fall through to the
    // default model lookup instead of being misrouted to a non-existent
    // provider and surfaced as a 400.
    const providerConfig =
      await providerMessagesHandlerDependencies.resolveProviderConfig(
        providerModelAlias.provider,
      )
    if (providerConfig) {
      anthropicPayload.model = providerModelAlias.model
      return await handleProviderMessagesForProvider(c, {
        payload: anthropicPayload,
        provider: providerModelAlias.provider,
        usageEndpoint: dispatchOptions.usageEndpoint,
      })
    }
  }

  debugJson(logger, "Anthropic request payload:", anthropicPayload)

  normalizeSystemMessages(anthropicPayload)

  sanitizeIdeTools(anthropicPayload)

  const subagentMarker =
    dispatchOptions.subagentMarker
    ?? parseSubagentMarkerFromFirstUser(anthropicPayload)
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  let sessionId =
    dispatchOptions.sessionId ?? getRootSessionId(anthropicPayload, c)

  // claude code and opencode compact / auto-continue detection
  const compactType =
    dispatchOptions.compactType ?? getCompactType(anthropicPayload)

  // fix claude code 2.0.28+ warmup request consume premium request, forcing small model if no tools are used
  // set "CLAUDE_CODE_SUBAGENT_MODEL": "you small model" also can avoid this
  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)
  if (!state.tokenBasedBilling && !shouldUseClaudeAutoModel) {
    const tools = anthropicPayload.tools
    const noTools = !tools || tools.length === 0
    if (anthropicBeta && noTools && compactType === 0) {
      anthropicPayload.model = getSmallModel()
    }
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

  const requestId =
    dispatchOptions.requestId
    ?? generateRequestIdFromPayload(anthropicPayload, sessionId)
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
        usageEndpoint: dispatchOptions.usageEndpoint,
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
        usageEndpoint: dispatchOptions.usageEndpoint,
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
      usageEndpoint: dispatchOptions.usageEndpoint,
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
