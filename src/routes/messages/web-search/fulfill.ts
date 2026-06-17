import type { ConsolaInstance } from "consola"
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type { Model } from "~/services/copilot/get-models"

import {
  getMessageApiWebSearchModel,
  isResponsesApiWebSearchEnabled,
} from "~/lib/config"
import { findEndpointModel } from "~/lib/models"
import {
  parseProviderModelAlias,
  type ProviderModelAlias,
} from "~/lib/provider-model"
import {
  createCopilotTokenUsageRecorder,
  normalizeResponsesUsage,
  type CopilotUsageTokens,
  type UsageTokens,
} from "~/lib/token-usage"
import {
  generateRequestIdFromPayload,
  getRootSessionId,
  getUUID,
  parseUserIdMetadata,
} from "~/lib/utils"
import {
  createResponses as createCopilotResponses,
  type CopilotUsage,
  type ResponseStreamEvent,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponsesStream,
} from "~/services/copilot/create-responses"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicWebSearchContentBlock,
  AnthropicWebSearchResultItem,
} from "../anthropic-types"
import { getCompactType, normalizeSystemMessages } from "../preprocess"
import { translateAnthropicMessagesToResponsesPayload } from "../responses-translation"
import { parseSubagentMarkerFromFirstUser } from "../subagent-marker"
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
import { debugJson } from "~/lib/logger"

export const webSearchFlowDependencies = {
  createResponses: createCopilotResponses,
  createUsageRecorder: (
    payload: AnthropicMessagesPayload,
    sessionId?: string,
    webSearchModel?: string,
  ): ((usage: UsageTokens, copilotUsage?: CopilotUsageTokens | null) => void) =>
    createCopilotTokenUsageRecorder({
      endpoint: "responses",
      fallbackSessionId: sessionId,
      model: webSearchModel ?? payload.model,
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

export const extractWebSearchConfig = (
  payload: AnthropicMessagesPayload,
): WebSearchToolConfig => {
  const tool = payload.tools?.find(isWebSearchServerTool)
  return {
    allowedDomains: tool?.allowed_domains,
    blockedDomains: tool?.blocked_domains,
    userLocation: tool?.user_location,
  }
}

export interface ReconstructedWebSearchResponse
  extends Omit<AnthropicResponse, "content"> {
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
    blocks.push(
      {
        type: "server_tool_use",
        id: toolUseId,
        name: "web_search",
        input: { query },
      },
      buildWebSearchResultBlock(toolUseId, extract),
    )
  }
  blocks.push({ type: "text", text: extract.answerText })
  return blocks
}

export const prepareWebSearchResponsesPayload = (
  payload: AnthropicMessagesPayload,
  options: {
    model?: string
    subagentAgentId?: string | null
  } = {},
): ResponsesPayload => {
  const config = extractWebSearchConfig(payload)
  const switchedPayload: AnthropicMessagesPayload = {
    ...payload,
    model: options.model ?? payload.model,
    tools: [],
    stream: true,
  }

  const responsesPayload = translateAnthropicMessagesToResponsesPayload(
    switchedPayload,
    options.subagentAgentId,
  )
  responsesPayload.tools = [buildResponsesWebSearchTool(config)]
  responsesPayload.tool_choice = undefined
  return responsesPayload
}

export const reconstructWebSearchResponse = (
  payload: AnthropicMessagesPayload,
  result: ResponsesResult,
  options: { requestId: string },
): {
  extract: WebSearchExtract
  response: ReconstructedWebSearchResponse
} => {
  const extract = extractWebSearchResult(result)
  const response: ReconstructedWebSearchResponse = {
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

  return { extract, response }
}

type WebSearchResponsesStreamEvent = ResponseStreamEvent | StreamEventRecord

type StreamEventRecord = Record<string, unknown> & {
  type: string
}

interface CollectedOutputTextPart {
  annotations: Array<unknown>
  contentIndex: number
  itemId?: string
  outputIndex: number
  text: string
}

interface WebSearchResponsesStreamCollection {
  createdResponse?: ResponsesResult
  outputItemsByIndex: Map<number, StreamEventRecord>
  terminalResponse?: ResponsesResult
  textPartsByKey: Map<string, CollectedOutputTextPart>
}

export const collectWebSearchResponsesStreamResult = async ({
  errorMessagePrefix = "Web search responses stream",
  parseEvent = parseWebSearchResponsesStreamEvent,
  upstreamResponse,
  logger,
}: {
  errorMessagePrefix?: string
  parseEvent?: (data: string) => WebSearchResponsesStreamEvent | null
  upstreamResponse: ResponsesStream
  logger: ConsolaInstance
}): Promise<ResponsesResult> => {
  const state = createWebSearchResponsesStreamCollection()

  for await (const chunk of upstreamResponse) {
    debugJson(logger, "Received web search responses stream chunk:", chunk.data)
    if (chunk.event === "ping") {
      continue
    }

    if (!chunk.data || chunk.data === "[DONE]") {
      continue
    }

    const parsed = parseEvent(chunk.data)
    if (!parsed) {
      continue
    }

    collectWebSearchResponsesStreamEvent(parsed, state)

    if (parsed.type === "error") {
      throw new Error(
        getStreamErrorMessage(parsed) ?? `${errorMessagePrefix} failed`,
      )
    }

    if (isResponsesTerminalEvent(parsed)) {
      return buildWebSearchResponsesStreamResult(state)
    }
  }

  throw new Error(`${errorMessagePrefix} ended without a terminal event`)
}

const parseWebSearchResponsesStreamEvent = (
  data: string,
): WebSearchResponsesStreamEvent | null => {
  try {
    return JSON.parse(data) as WebSearchResponsesStreamEvent
  } catch {
    return null
  }
}

const isWebSearchResponsesStream = (
  value: unknown,
): value is ResponsesStream => {
  return (
    Boolean(value)
    && typeof (value as ResponsesStream)[Symbol.asyncIterator] === "function"
  )
}

const isResponsesTerminalEvent = (
  event: WebSearchResponsesStreamEvent,
): event is WebSearchResponsesStreamEvent & {
  response: ResponsesResult
  type: "response.completed" | "response.failed" | "response.incomplete"
} =>
  (event.type === "response.completed"
    || event.type === "response.failed"
    || event.type === "response.incomplete")
  && getResponsesResult(event.response) !== undefined

const createWebSearchResponsesStreamCollection =
  (): WebSearchResponsesStreamCollection => ({
    outputItemsByIndex: new Map(),
    textPartsByKey: new Map(),
  })

const collectWebSearchResponsesStreamEvent = (
  event: WebSearchResponsesStreamEvent,
  state: WebSearchResponsesStreamCollection,
): void => {
  if (event.type === "response.created") {
    state.createdResponse = getResponsesResult(event.response)
    return
  }

  if (isResponsesTerminalEvent(event)) {
    state.terminalResponse = event.response
    return
  }

  if (
    event.type === "response.output_item.added"
    || event.type === "response.output_item.done"
  ) {
    const outputIndex = getNumber(event.output_index)
    const item = getRecord(event.item)
    if (outputIndex !== undefined && item) {
      state.outputItemsByIndex.set(outputIndex, item)
    }
    return
  }

  if (event.type === "response.output_text.delta") {
    const part = getOrCreateOutputTextPart(event, state)
    const delta = getString(event.delta)
    if (part && delta) {
      part.text += delta
    }
    return
  }

  if (event.type === "response.output_text.done") {
    const part = getOrCreateOutputTextPart(event, state)
    const text = getString(event.text)
    if (part && text !== undefined) {
      part.text = text
    }
    return
  }

  if (event.type === "response.output_text.annotation.added") {
    const part = getOrCreateOutputTextPart(event, state)
    const annotation = event.annotation
    if (part && annotation !== undefined) {
      part.annotations.push(annotation)
    }
    return
  }

  if (event.type === "response.content_part.done") {
    collectDoneContentPart(event, state)
  }
}

const buildWebSearchResponsesStreamResult = (
  state: WebSearchResponsesStreamCollection,
): ResponsesResult => {
  const response = state.terminalResponse ?? state.createdResponse
  if (!response) {
    throw new Error("Web search responses stream ended without a response")
  }

  const output = buildCollectedWebSearchOutput(state)
  return {
    ...response,
    output: output.length > 0 ? output : response.output,
  }
}

const buildCollectedWebSearchOutput = (
  state: WebSearchResponsesStreamCollection,
): ResponsesResult["output"] =>
  [...state.outputItemsByIndex.entries()]
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([outputIndex, item]) =>
      mergeOutputItemWithCollectedText(outputIndex, item, state),
    ) as unknown as ResponsesResult["output"]

const mergeOutputItemWithCollectedText = (
  outputIndex: number,
  item: StreamEventRecord,
  state: WebSearchResponsesStreamCollection,
): StreamEventRecord => {
  if (item.type !== "message") {
    return item
  }

  const collectedParts = getCollectedTextParts(outputIndex, state)
  if (collectedParts.length === 0) {
    return item
  }

  const content = getArray(item.content)
  for (const part of collectedParts) {
    const existingPart = getRecord(content[part.contentIndex])
    content[part.contentIndex] = {
      ...existingPart,
      type: "output_text",
      text: part.text,
      annotations: mergeAnnotations(
        existingPart?.annotations,
        part.annotations,
      ),
    }
  }

  return {
    ...item,
    content,
  }
}

const collectDoneContentPart = (
  event: WebSearchResponsesStreamEvent,
  state: WebSearchResponsesStreamCollection,
): void => {
  const eventRecord = getRecord(event)
  const partRecord = getRecord(eventRecord?.part)
  if (partRecord?.type !== "output_text") {
    return
  }

  const part = getOrCreateOutputTextPart(event, state)
  if (!part) {
    return
  }

  const text = getString(partRecord.text)
  if (text !== undefined) {
    part.text = text
  }

  const annotations = getArray(partRecord.annotations)
  if (annotations.length > 0) {
    part.annotations.push(...annotations)
  }
}

const getOrCreateOutputTextPart = (
  event: WebSearchResponsesStreamEvent,
  state: WebSearchResponsesStreamCollection,
): CollectedOutputTextPart | undefined => {
  const eventRecord = getRecord(event)
  const outputIndex = getNumber(eventRecord?.output_index)
  const contentIndex = getNumber(eventRecord?.content_index)
  if (outputIndex === undefined || contentIndex === undefined) {
    return undefined
  }

  const key = `${outputIndex}:${contentIndex}`
  let part = state.textPartsByKey.get(key)
  if (!part) {
    part = {
      annotations: [],
      contentIndex,
      itemId: getString(eventRecord?.item_id),
      outputIndex,
      text: "",
    }
    state.textPartsByKey.set(key, part)
  }

  return part
}

const getCollectedTextParts = (
  outputIndex: number,
  state: WebSearchResponsesStreamCollection,
): Array<CollectedOutputTextPart> =>
  [...state.textPartsByKey.values()]
    .filter((part) => part.outputIndex === outputIndex)
    .sort(
      (left, right) =>
        left.contentIndex - right.contentIndex
        || (left.itemId ?? "").localeCompare(right.itemId ?? ""),
    )

const mergeAnnotations = (
  existingAnnotations: unknown,
  collectedAnnotations: Array<unknown>,
): Array<unknown> => {
  const annotations = getArray(existingAnnotations)
  annotations.push(...collectedAnnotations)
  return annotations
}

const getResponsesResult = (value: unknown): ResponsesResult | undefined =>
  getRecord(value) as ResponsesResult | undefined

const getRecord = (value: unknown): StreamEventRecord | undefined =>
  value && typeof value === "object" ? (value as StreamEventRecord) : undefined

const getArray = (value: unknown): Array<unknown> =>
  Array.isArray(value) ? Array.from(value as Array<unknown>) : []

const getStreamErrorMessage = (
  event: WebSearchResponsesStreamEvent,
): string | undefined => {
  const eventRecord = getRecord(event)
  const error = getRecord(eventRecord?.error)
  return getString(error?.message) ?? getString(eventRecord?.message)
}

const getNumber = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined

const getString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const createUsageRecorder = (
  payload: AnthropicMessagesPayload,
  sessionId?: string,
  webSearchModel?: string,
): ((usage: UsageTokens, copilotUsage?: CopilotUsageTokens | null) => void) =>
  webSearchFlowDependencies.createUsageRecorder(
    payload,
    sessionId,
    webSearchModel,
  )

/**
 * Entry point for web-search detection and routing on /v1/messages.
 * Called after model mapping but before provider alias resolution and
 * preprocessing. Returns a Response when web search is handled (provider
 * reroute or responses-native), or `null` when no web_search tool is
 * present or the tool was stripped (caller continues normal flow).
 *
 * Uses a callback for provider forwarding to avoid circular imports.
 */
export const tryHandleWebSearch = async (
  c: Context,
  payload: AnthropicMessagesPayload,
  options: {
    logger: ConsolaInstance
    forwardToProvider: (
      c: Context,
      payload: AnthropicMessagesPayload,
      provider: string,
    ) => Promise<Response>
  },
): Promise<Response | null> => {
  if (!hasWebSearchServerTool(payload)) return null

  normalizeSystemMessages(payload)

  const route = resolveWebSearchRoute(payload, {
    webSearchModel: getMessageApiWebSearchModel(),
    responsesWebSearchEnabled: isResponsesApiWebSearchEnabled(),
  })

  if (route.kind === "provider") {
    payload.model = route.alias.model
    return await options.forwardToProvider(c, payload, route.alias.provider)
  }

  if (route.kind === "responses") {
    const subagentMarker = parseSubagentMarkerFromFirstUser(payload)
    let sessionId = getRootSessionId(payload, c)
    const requestId = generateRequestIdFromPayload(payload, sessionId)
    if (!sessionId) {
      sessionId = getUUID(requestId)
    }
    const compactType = getCompactType(payload)
    return await handleWebSearchViaResponses(c, payload, {
      subagentMarker,
      webSearchModel: route.model,
      requestId,
      sessionId,
      compactType,
      logger: options.logger,
    })
  }

  stripWebSearchServerTool(payload)
  return null
}

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

  // Switch to the GPT web search model and drop the Anthropic server tool so the
  // standard Anthropic -> Responses translation does not choke on it; the
  // Responses web_search tool is attached to the translated payload instead.
  const responsesPayload = prepareWebSearchResponsesPayload(payload, {
    model: webSearchModel,
    subagentAgentId: options.subagentMarker?.agent_id,
  })

  const selectedModel: Model | undefined = findEndpointModel(webSearchModel)
  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const transport =
    getResponsesTransportForModel(selectedModel, {
      compactType: options.compactType,
    }) ?? "http"

  debugJson(
    logger,
    `Switching web search request to model: ${webSearchModel}`,
    responsesPayload,
  )

  const upstreamResult = await webSearchFlowDependencies.createResponses(
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
  )

  const result =
    isWebSearchResponsesStream(upstreamResult) ?
      await collectWebSearchResponsesStreamResult({
        errorMessagePrefix: "Web search responses stream",
        upstreamResponse: upstreamResult,
        logger,
      })
    : upstreamResult

  const { extract, response } = reconstructWebSearchResponse(payload, result, {
    requestId: options.requestId,
  })

  debugJson(
    logger,
    `Web search via responses: ${extract.queries.length} quer(y/ies), ${extract.sources.length} source(s)`,
    result,
  )

  const recordUsage = createUsageRecorder(
    payload,
    options.sessionId,
    webSearchModel,
  )
  recordUsage(
    normalizeResponsesUsage(result.usage),
    copilotUsageFromResponse(result.copilot_usage),
  )

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

function copilotUsageFromResponse(
  copilotUsage: CopilotUsage | null | undefined,
): CopilotUsageTokens {
  if (!copilotUsage) {
    return {}
  }

  return {
    token_details: copilotUsage.token_details,
    total_nano_aiu: copilotUsage.total_nano_aiu,
  }
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
  response: ReconstructedWebSearchResponse,
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

  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: response.stop_reason,
        stop_sequence: response.stop_sequence,
      },
      usage: { output_tokens: response.usage.output_tokens },
    },
    { type: "message_stop" },
  )

  return events
}
