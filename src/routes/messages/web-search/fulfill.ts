import type { ConsolaInstance } from "consola"
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type { Model } from "~/services/copilot/get-models"

import { findEndpointModel } from "~/lib/models"
import {
  parseProviderModelAlias,
  type ProviderModelAlias,
} from "~/lib/provider-model"
import {
  createCopilotTokenUsageRecorder,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { getUUID, parseUserIdMetadata } from "~/lib/utils"
import {
  createResponses as createCopilotResponses,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicWebSearchContentBlock,
  AnthropicWebSearchResultItem,
} from "../anthropic-types"
import { translateAnthropicMessagesToResponsesPayload } from "../responses-translation"
import {
  getResponsesRequestOptions,
  getResponsesTransportForModel,
} from "../../responses/utils"
import {
  buildResponsesWebSearchTool,
  extractWebSearchResult,
  type WebSearchExtract,
  type WebSearchToolConfig,
} from "./backend"

export const webSearchFlowDependencies = {
  createResponses: createCopilotResponses,
  createUsageRecorder: (
    payload: AnthropicMessagesPayload,
    sessionId?: string,
  ): ((usage: UsageTokens) => void) =>
    createCopilotTokenUsageRecorder({
      endpoint: "responses",
      fallbackSessionId: sessionId,
      model: payload.model,
      sessionId: parseUserIdMetadata(payload.metadata?.user_id).sessionId,
    }),
}

export interface WebSearchFlowOptions {
  logger: ConsolaInstance
  subagentMarker?: SubagentMarker | null
  /** GPT (Responses-capable) model the web search request is switched to. */
  webSearchModel: string
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

/**
 * True when web_search is the ONLY tool in the request. Mixing web_search with
 * other tools is intentionally unsupported, so only these requests are switched
 * to the web search model.
 */
export const isWebSearchOnlyRequest = (
  payload: AnthropicMessagesPayload,
): boolean =>
  Array.isArray(payload.tools)
  && payload.tools.length > 0
  && payload.tools.every(isWebSearchServerTool)

/** Removes web_search server tools (used for unsupported mixed-tool requests). */
export const stripWebSearchServerTool = (
  payload: AnthropicMessagesPayload,
): void => {
  if (!Array.isArray(payload.tools)) return
  payload.tools = payload.tools.filter((tool) => !isWebSearchServerTool(tool))
}

/**
 * Decides how a web-search request should be handled. Pure so the routing is
 * unit-testable. Assumes the caller already confirmed a web_search tool exists.
 *
 * - `provider`: messageApiWebSearchModel is a `provider/model` alias whose
 *   message API supports websearch natively — pass the tool straight through.
 * - `responses`: a Copilot GPT model — run it via the /responses web_search.
 * - `strip`: mixing with other tools, no model configured, or web search off —
 *   drop the tool and continue normally.
 */
export type WebSearchRoute =
  | { kind: "provider"; alias: ProviderModelAlias }
  | { kind: "responses"; model: string }
  | { kind: "strip" }

export const resolveWebSearchRoute = (
  payload: AnthropicMessagesPayload,
  options: { webSearchModel?: string; responsesWebSearchEnabled: boolean },
): WebSearchRoute => {
  const { webSearchModel, responsesWebSearchEnabled } = options
  if (!webSearchModel || !isWebSearchOnlyRequest(payload)) {
    return { kind: "strip" }
  }
  const alias = parseProviderModelAlias(webSearchModel)
  if (alias) {
    return { kind: "provider", alias }
  }
  if (responsesWebSearchEnabled) {
    return { kind: "responses", model: webSearchModel }
  }
  return { kind: "strip" }
}

const extractWebSearchConfig = (
  payload: AnthropicMessagesPayload,
): WebSearchToolConfig => {
  const tool = payload.tools?.find(isWebSearchServerTool)
  return {
    allowedDomains: tool?.allowed_domains,
    blockedDomains: tool?.blocked_domains,
    userLocation: tool?.user_location,
  }
}

interface ReconstructedResponse extends Omit<AnthropicResponse, "content"> {
  content: Array<AnthropicTextBlock | AnthropicWebSearchContentBlock>
}

const buildWebSearchResultBlock = (
  toolUseId: string,
  extract: WebSearchExtract,
): AnthropicWebSearchContentBlock => {
  const items: Array<AnthropicWebSearchResultItem> = extract.sources.map(
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
    tool_use_id: toolUseId,
    content: items,
  }
}

/**
 * Reconstructs a native Anthropic assistant response from the GPT web search
 * result: one server_tool_use + web_search_tool_result pair, then the answer.
 */
const buildResponseContent = (
  requestId: string,
  extract: WebSearchExtract,
): Array<AnthropicTextBlock | AnthropicWebSearchContentBlock> => {
  const blocks: Array<AnthropicTextBlock | AnthropicWebSearchContentBlock> = []
  const query = extract.queries[0] ?? ""
  if (extract.sources.length > 0 || query) {
    const toolUseId = `srvtoolu_${getUUID(requestId)}`
    blocks.push({
      type: "server_tool_use",
      id: toolUseId,
      name: "web_search",
      input: { query },
    })
    blocks.push(buildWebSearchResultBlock(toolUseId, extract))
  }
  blocks.push({ type: "text", text: extract.answerText })
  return blocks
}

const createUsageRecorder = (
  payload: AnthropicMessagesPayload,
  sessionId?: string,
): ((usage: UsageTokens) => void) =>
  webSearchFlowDependencies.createUsageRecorder(payload, sessionId)

/**
 * Handles a web-search-only Claude (Messages API) request by switching it to a
 * Responses-capable GPT model (`webSearchModel`), running Copilot's native
 * /responses web_search in a single call, and reconstructing native Anthropic
 * server_tool_use + web_search_tool_result blocks. Streaming and non-streaming
 * are both supported (streaming replays the result as a synthetic SSE stream).
 */
export const handleWebSearchViaResponses = async (
  c: Context,
  payload: AnthropicMessagesPayload,
  options: WebSearchFlowOptions,
) => {
  const { logger, webSearchModel } = options
  const wantsStream = Boolean(payload.stream)
  const config = extractWebSearchConfig(payload)

  // Switch to the GPT web search model and drop the Anthropic server tool so the
  // standard Anthropic -> Responses translation does not choke on it; the
  // Responses web_search tool is attached to the translated payload instead.
  const switchedPayload: AnthropicMessagesPayload = {
    ...payload,
    model: webSearchModel,
    tools: [],
    stream: false,
  }

  const responsesPayload = translateAnthropicMessagesToResponsesPayload(
    switchedPayload,
    options.subagentMarker?.agent_id,
  )
  responsesPayload.tools = [buildResponsesWebSearchTool(config)]
  responsesPayload.tool_choice = undefined

  const selectedModel: Model | undefined = findEndpointModel(webSearchModel)
  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const transport =
    getResponsesTransportForModel(selectedModel, {
      compactType: options.compactType,
    }) ?? "http"

  logger.debug(`Switching web search request to model: ${webSearchModel}`)
  const result = (await webSearchFlowDependencies.createResponses(
    responsesPayload,
    {
      vision,
      initiator,
      transport,
      subagentMarker: options.subagentMarker,
      requestId: options.requestId,
      sessionId: options.sessionId,
      compactType: options.compactType,
    },
  )) as ResponsesResult

  const extract = extractWebSearchResult(result)
  logger.debug(
    `Web search via responses: ${extract.queries.length} quer(y/ies), ${extract.sources.length} source(s)`,
  )

  const recordUsage = createUsageRecorder(payload, options.sessionId)
  recordUsage(normalizeResponsesUsage(result.usage))

  const response: ReconstructedResponse = {
    id: result.id || getUUID(options.requestId),
    type: "message",
    role: "assistant",
    content: buildResponseContent(options.requestId, extract),
    model: payload.model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: result.usage?.input_tokens ?? 0,
      output_tokens: result.usage?.output_tokens ?? 0,
      server_tool_use: {
        web_search_requests: Math.max(extract.queries.length, 1),
      },
    } as AnthropicResponse["usage"],
  }

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
  block: AnthropicTextBlock | AnthropicWebSearchContentBlock,
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
