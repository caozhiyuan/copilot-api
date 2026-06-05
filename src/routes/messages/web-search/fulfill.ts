import type { ConsolaInstance } from "consola"
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type { Model } from "~/services/copilot/get-models"

import {
  createCopilotTokenUsageRecorder,
  normalizeAnthropicUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { getUUID, parseUserIdMetadata } from "~/lib/utils"
import { createMessages as createCopilotMessages } from "~/services/copilot/create-messages"

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTool,
  AnthropicToolUseBlock,
  AnthropicWebSearchContentBlock,
  AnthropicWebSearchResultItem,
} from "../anthropic-types"
import { prepareMessagesApiPayload } from "../preprocess"
import { runCopilotWebSearch, type WebSearchResult } from "./backend"

const WEB_SEARCH_TOOL_NAME = "web_search"
const DEFAULT_MAX_USES = 5
const HARD_MAX_ROUNDS = 9

export const webSearchFlowDependencies = {
  createMessages: createCopilotMessages,
  runWebSearch: runCopilotWebSearch,
  createUsageRecorder: (
    payload: AnthropicMessagesPayload,
    sessionId?: string,
  ): ((usage: UsageTokens) => void) =>
    createCopilotTokenUsageRecorder({
      endpoint: "messages",
      fallbackSessionId: sessionId,
      model: payload.model,
      sessionId: parseUserIdMetadata(payload.metadata?.user_id).sessionId,
    }),
}

interface WebSearchToolConfig {
  maxUses?: number
  allowedDomains?: Array<string>
  blockedDomains?: Array<string>
  userLocation?: Record<string, unknown>
}

export interface WebSearchFlowOptions {
  logger: ConsolaInstance
  anthropicBetaHeader?: string
  subagentMarker?: SubagentMarker | null
  selectedModel?: Model
  requestId: string
  sessionId?: string
  compactType?: CompactType
}

const isWebSearchServerTool = (tool: AnthropicTool): boolean =>
  typeof tool.type === "string"
  && tool.type.startsWith("web_search")
  && !tool.input_schema

/** True when the payload carries an Anthropic server-side web_search tool. */
export const hasWebSearchServerTool = (
  payload: AnthropicMessagesPayload,
): boolean =>
  Array.isArray(payload.tools) && payload.tools.some(isWebSearchServerTool)

/** Removes web_search server tools (used when the feature is disabled). */
export const stripWebSearchServerTool = (
  payload: AnthropicMessagesPayload,
): void => {
  if (!Array.isArray(payload.tools)) return
  payload.tools = payload.tools.filter((tool) => !isWebSearchServerTool(tool))
}

const extractWebSearchConfig = (
  payload: AnthropicMessagesPayload,
): WebSearchToolConfig | null => {
  const tool = payload.tools?.find(isWebSearchServerTool)
  if (!tool) return null
  return {
    maxUses: tool.max_uses,
    allowedDomains: tool.allowed_domains,
    blockedDomains: tool.blocked_domains,
    userLocation: tool.user_location,
  }
}

const WEB_SEARCH_FUNCTION_DESCRIPTION =
  "Search the web for up-to-date information. Use this whenever the answer "
  + "depends on current events, recent releases, prices, or any fact that may "
  + "have changed since your training cutoff. Returns a grounded summary with "
  + "source URLs you can cite."

const buildWebSearchFunctionTool = (): AnthropicTool => ({
  name: WEB_SEARCH_TOOL_NAME,
  description: WEB_SEARCH_FUNCTION_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
})

/**
 * Replaces the web_search server tool with an equivalent function tool that
 * Copilot's Claude will accept and invoke. Other tools are kept untouched.
 */
const transformToolsForLoop = (payload: AnthropicMessagesPayload): void => {
  if (!Array.isArray(payload.tools)) return
  const functionTool = buildWebSearchFunctionTool()
  let replaced = false
  payload.tools = payload.tools.map((tool) => {
    if (!isWebSearchServerTool(tool)) return tool
    replaced = true
    return functionTool
  })
  if (!replaced) payload.tools.push(functionTool)
}

const asBlocks = (
  content: AnthropicResponse["content"],
): Array<AnthropicAssistantContentBlock> =>
  Array.isArray(content) ? content : []

const isToolUse = (
  block: AnthropicAssistantContentBlock,
): block is AnthropicToolUseBlock => block.type === "tool_use"

const isWebSearchToolUse = (
  block: AnthropicAssistantContentBlock,
): block is AnthropicToolUseBlock =>
  isToolUse(block) && block.name === WEB_SEARCH_TOOL_NAME

const stripThinking = (
  content: Array<AnthropicAssistantContentBlock>,
): Array<AnthropicAssistantContentBlock> =>
  content.filter((block) => block.type !== "thinking")

const formatToolResultText = (
  query: string,
  result: WebSearchResult,
): string => {
  if (result.error) {
    return (
      `Web search for "${query}" was unavailable (${result.error}). `
      + "Answer using your own knowledge and tell the user live search failed."
    )
  }
  let text = result.answerText
  if (result.sources.length > 0) {
    const sources = result.sources
      .map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`)
      .join("\n")
    text += `\n\nSources:\n${sources}`
  }
  return text
}

const emptyUsage = (): AnthropicResponse["usage"] => ({
  input_tokens: 0,
  output_tokens: 0,
})

const addUsage = (
  acc: AnthropicResponse["usage"],
  next: AnthropicResponse["usage"] | undefined,
): AnthropicResponse["usage"] => {
  if (!next) return acc
  return {
    input_tokens: acc.input_tokens + (next.input_tokens ?? 0),
    output_tokens: acc.output_tokens + (next.output_tokens ?? 0),
    cache_creation_input_tokens:
      (acc.cache_creation_input_tokens ?? 0)
      + (next.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (acc.cache_read_input_tokens ?? 0) + (next.cache_read_input_tokens ?? 0),
    service_tier: next.service_tier ?? acc.service_tier,
  }
}

interface CollectedSearch {
  id: string
  query: string
  result: WebSearchResult
}

interface ReconstructedResponse extends Omit<AnthropicResponse, "content"> {
  content: Array<
    AnthropicAssistantContentBlock | AnthropicWebSearchContentBlock
  >
}

const buildWebSearchResultBlock = (
  search: CollectedSearch,
): AnthropicWebSearchContentBlock => {
  if (search.result.error) {
    return {
      type: "web_search_tool_result",
      tool_use_id: search.id,
      content: {
        type: "web_search_tool_result_error",
        error_code: "unavailable",
      },
    }
  }
  const items: Array<AnthropicWebSearchResultItem> = search.result.sources.map(
    (source) => ({
      type: "web_search_result",
      url: source.url,
      title: source.title,
      page_age: source.page_age ?? null,
      encrypted_content: "",
    }),
  )
  return {
    type: "web_search_tool_result",
    tool_use_id: search.id,
    content: items,
  }
}

const buildResponseContent = (
  collected: Array<CollectedSearch>,
  finalContent: Array<AnthropicAssistantContentBlock>,
): Array<AnthropicAssistantContentBlock | AnthropicWebSearchContentBlock> => {
  const blocks: Array<
    AnthropicAssistantContentBlock | AnthropicWebSearchContentBlock
  > = []
  for (const search of collected) {
    blocks.push({
      type: "server_tool_use",
      id: search.id,
      name: "web_search",
      input: { query: search.query },
    })
    blocks.push(buildWebSearchResultBlock(search))
  }
  for (const block of finalContent) {
    // Drop any dangling web_search tool_use; keep real client tools and text.
    if (isWebSearchToolUse(block)) continue
    blocks.push(block)
  }
  return blocks
}

interface LoopResult {
  response: ReconstructedResponse
  usage: AnthropicResponse["usage"]
  searchCount: number
}

const runFulfillmentLoop = async (
  basePayload: AnthropicMessagesPayload,
  config: WebSearchToolConfig,
  options: WebSearchFlowOptions,
): Promise<LoopResult> => {
  const { logger } = options
  const messages = [...basePayload.messages]
  const collected: Array<CollectedSearch> = []
  let usageAcc = emptyUsage()

  const maxRounds = Math.min(
    (config.maxUses ?? DEFAULT_MAX_USES) + 1,
    HARD_MAX_ROUNDS,
  )

  const callClaude = async (): Promise<AnthropicResponse> => {
    const loopPayload: AnthropicMessagesPayload = {
      ...basePayload,
      messages,
      stream: false,
    }
    const response = (await webSearchFlowDependencies.createMessages(
      loopPayload,
      options.anthropicBetaHeader,
      {
        subagentMarker: options.subagentMarker,
        requestId: options.requestId,
        sessionId: options.sessionId,
        compactType: options.compactType,
      },
    )) as AnthropicResponse
    usageAcc = addUsage(usageAcc, response.usage)
    return response
  }

  const finalize = (
    finalContent: Array<AnthropicAssistantContentBlock>,
    stopReason: AnthropicResponse["stop_reason"],
    id: string,
  ): LoopResult => {
    const response: ReconstructedResponse = {
      id,
      type: "message",
      role: "assistant",
      content: buildResponseContent(collected, finalContent),
      model: basePayload.model,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        ...usageAcc,
        ...(collected.length > 0 ?
          {
            server_tool_use: { web_search_requests: collected.length },
          }
        : {}),
      } as AnthropicResponse["usage"],
    }
    return { response, usage: usageAcc, searchCount: collected.length }
  }

  for (let round = 1; round <= maxRounds; round++) {
    const response = await callClaude()
    const content = asBlocks(response.content)
    const webUses = content.filter(isWebSearchToolUse)
    const otherUses = content.filter(
      (block) => isToolUse(block) && !isWebSearchToolUse(block),
    )

    if (webUses.length === 0) {
      logger.debug(`Web search loop done after ${round} round(s), no search`)
      return finalize(content, response.stop_reason ?? "end_turn", response.id)
    }

    if (otherUses.length > 0) {
      // Mixed turn: client tools must be executed by the caller. Hand back
      // the response (web_search tool_use blocks are dropped downstream).
      logger.debug("Web search loop hit a mixed tool turn; returning to client")
      return finalize(content, response.stop_reason ?? "tool_use", response.id)
    }

    // Pure web-search turn: fulfill every search and continue.
    messages.push({ role: "assistant", content: stripThinking(content) })
    const toolResults = []
    for (const toolUse of webUses) {
      const input = toolUse.input as { query?: unknown; q?: unknown }
      const rawQuery =
        typeof input.query === "string" ? input.query
        : typeof input.q === "string" ? input.q
        : ""
      const query = rawQuery.trim()
      logger.debug(`Web search: ${query}`)
      const result = await webSearchFlowDependencies.runWebSearch(query, {
        allowedDomains: config.allowedDomains,
        blockedDomains: config.blockedDomains,
        userLocation: config.userLocation,
        requestId: `${options.requestId}-ws${collected.length}`,
        sessionId: options.sessionId,
      })
      collected.push({ id: toolUse.id, query, result })
      toolResults.push({
        type: "tool_result" as const,
        tool_use_id: toolUse.id,
        content: formatToolResultText(query, result),
        is_error: Boolean(result.error),
      })
    }
    messages.push({ role: "user", content: toolResults })

    if (round === maxRounds) {
      // Cap reached: make one final call so Claude answers with the results.
      logger.debug("Web search loop reached cap; requesting final answer")
      const finalResponse = await callClaude()
      const finalContent = asBlocks(finalResponse.content).filter(
        (block) => !isWebSearchToolUse(block),
      )
      return finalize(
        finalContent,
        finalResponse.stop_reason ?? "end_turn",
        finalResponse.id,
      )
    }
  }

  // Unreachable: the loop always returns. Provided for type completeness.
  return finalize(
    [{ type: "text", text: "" }],
    "end_turn",
    getUUID(options.requestId),
  )
}

const createUsageRecorder = (
  payload: AnthropicMessagesPayload,
  sessionId?: string,
): ((usage: UsageTokens) => void) =>
  webSearchFlowDependencies.createUsageRecorder(payload, sessionId)

/**
 * Fulfills an Anthropic web_search server tool for a Claude model by running an
 * agentic loop against Copilot's /v1/messages and answering each search via the
 * GPT /responses web_search backend. Supports both streaming and non-streaming.
 */
export const handleWithMessagesApiWebSearch = async (
  c: Context,
  payload: AnthropicMessagesPayload,
  options: WebSearchFlowOptions,
) => {
  const { logger } = options
  const config = extractWebSearchConfig(payload) ?? {}
  const wantsStream = Boolean(payload.stream)

  prepareMessagesApiPayload(payload, options.selectedModel)
  transformToolsForLoop(payload)

  const recordUsage = createUsageRecorder(payload, options.sessionId)

  logger.debug("Starting Claude web search fulfillment loop")
  const { response, usage } = await runFulfillmentLoop(payload, config, options)
  recordUsage(normalizeAnthropicUsage(usage))

  if (!wantsStream) {
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

// --- Synthetic SSE replay -------------------------------------------------

interface SyntheticEvent {
  type: string
  [key: string]: unknown
}

const blockToStreamEvents = (
  block: AnthropicAssistantContentBlock | AnthropicWebSearchContentBlock,
  index: number,
): Array<SyntheticEvent> => {
  const start = (contentBlock: unknown): SyntheticEvent => ({
    type: "content_block_start",
    index,
    content_block: contentBlock,
  })
  const stop: SyntheticEvent = { type: "content_block_stop", index }

  switch (block.type) {
    case "text": {
      return [
        start({ type: "text", text: "" }),
        {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        },
        stop,
      ]
    }
    case "thinking": {
      return [
        start({ type: "thinking", thinking: "" }),
        {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.thinking },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: block.signature },
        },
        stop,
      ]
    }
    case "server_tool_use": {
      return [
        start({
          type: "server_tool_use",
          id: block.id,
          name: block.name,
          input: {},
        }),
        {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        },
        stop,
      ]
    }
    case "tool_use": {
      return [
        start({ type: "tool_use", id: block.id, name: block.name, input: {} }),
        {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        },
        stop,
      ]
    }
    case "web_search_tool_result": {
      // Full block delivered in content_block_start (Anthropic convention).
      return [start(block), stop]
    }
    default: {
      return [start(block), stop]
    }
  }
}

export const buildSyntheticStreamEvents = (
  response: ReconstructedResponse,
): Array<SyntheticEvent> => {
  const events: Array<SyntheticEvent> = []

  events.push({
    type: "message_start",
    message: {
      id: response.id,
      type: "message",
      role: "assistant",
      content: [],
      model: response.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { ...response.usage, output_tokens: 0 },
    },
  })

  response.content.forEach((block, index) => {
    events.push(...blockToStreamEvents(block, index))
  })

  events.push({
    type: "message_delta",
    delta: {
      stop_reason: response.stop_reason,
      stop_sequence: response.stop_sequence,
    },
    usage: { output_tokens: response.usage.output_tokens },
  })
  events.push({ type: "message_stop" })

  return events
}
