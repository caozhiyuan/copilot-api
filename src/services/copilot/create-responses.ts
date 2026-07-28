import consola from "consola"
import { events } from "fetch-event-stream"
import { createHash } from "node:crypto"

import type { SubagentMarker } from "~/lib/subagent"
import type { PooledWebSocketRequest } from "~/services/responses-websocket"

import {
  copilotBaseUrl,
  copilotHeaders,
  copilotWebSocketHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "~/lib/api-config"
import { COMPACT_REQUEST, type CompactType } from "~/lib/compact"
import {
  logCopilotQuotaSnapshots,
  logCopilotRateLimits,
  type CopilotQuotaSnapshot,
} from "~/lib/copilot-rate-limit"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import {
  createPooledWebSocketStream,
  createWebSocketUrl,
} from "~/services/responses-websocket"

export interface ResponsesPayload {
  model: string
  instructions?: string | null
  input?: string | Array<ResponseInputItem>
  tools?: Array<Tool> | null
  tool_choice?: ToolChoiceOptions | ToolChoiceFunction
  temperature?: number | null
  top_p?: number | null
  max_output_tokens?: number | null
  metadata?: Metadata | null
  stream?: boolean | null
  safety_identifier?: string | null
  prompt_cache_key?: string | null
  prompt_cache_retention?: "in_memory" | "24h" | null
  parallel_tool_calls?: boolean | null
  store?: boolean | null
  reasoning?: Reasoning | null
  context_management?: Array<ResponseContextManagementItem> | null
  include?: Array<ResponseIncludable>
  service_tier?: string | null // NOTE: Unsupported by GitHub Copilot
  [key: string]: unknown
}

export type ToolChoiceOptions = "none" | "auto" | "required"
export type ToolSearchExecution = "client" | "server"

export interface ToolChoiceFunction {
  name: string
  type: "function"
}

export type Tool =
  | FunctionTool
  | ToolSearchTool
  | NamespaceTool
  | Record<string, unknown>

export interface FunctionTool {
  name: string
  parameters: { [key: string]: unknown } | null
  strict: boolean | null
  type: "function"
  description?: string | null
  defer_loading?: boolean | null
}

export interface ToolSearchTool {
  type: "tool_search"
  execution?: ToolSearchExecution | null
  description?: string | null
  parameters?: { [key: string]: unknown } | null
}

export interface NamespaceTool {
  type: "namespace"
  name: string
  description?: string | null
  tools: Array<FunctionTool>
}

export type ResponseIncludable =
  | "file_search_call.results"
  | "web_search_call.results"
  | "web_search_call.action.sources"
  | "message.input_image.image_url"
  | "computer_call_output.output.image_url"
  | "reasoning.encrypted_content"
  | "code_interpreter_call.outputs"
  | "message.output_text.logprobs"

export interface Reasoning {
  effort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | null
  summary?: "auto" | "concise" | "detailed" | null
  context?: "auto" | "current_turn" | "all_turns" | null
}

export interface ResponseContextManagementCompactionItem {
  type: "compaction"
  compact_threshold: number
}

export type ResponseContextManagementItem =
  ResponseContextManagementCompactionItem

export interface ResponseInputMessage {
  type?: "message"
  role: "user" | "assistant" | "system" | "developer"
  content?: string | Array<ResponseInputContent>
  status?: string
  phase?: "commentary" | "final_answer"
}

export interface ResponseFunctionToolCallItem {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  status?: "in_progress" | "completed" | "incomplete"
  namespace?: string | null
}

export interface ResponseFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string | Array<ResponseInputContent>
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseToolSearchCallItem {
  type: "tool_search_call"
  call_id: string
  arguments: Record<string, unknown> | string
  execution?: ToolSearchExecution | null
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseToolSearchOutputItem {
  type: "tool_search_output"
  call_id: string
  tools: Array<Tool>
  execution?: ToolSearchExecution | null
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseInputReasoning {
  id?: string
  type: "reasoning"
  summary: Array<{
    type: "summary_text"
    text: string
  }>
  encrypted_content: string
}

export interface ResponseInputCompaction {
  id: string
  type: "compaction"
  encrypted_content: string
}

export interface ResponseInputCompactionTrigger {
  type: "compaction_trigger"
}

export interface ResponseInputAdditionalTools {
  id?: string
  role: "developer"
  tools: Array<Tool>
  type: "additional_tools"
}

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseFunctionToolCallItem
  | ResponseFunctionCallOutputItem
  | ResponseToolSearchCallItem
  | ResponseToolSearchOutputItem
  | ResponseInputReasoning
  | ResponseInputCompaction
  | ResponseInputCompactionTrigger
  | ResponseInputAdditionalTools
  | Record<string, unknown>

export type ResponseInputContent =
  | ResponseInputText
  | ResponseInputImage
  | ResponseInputFile
  | Record<string, unknown>

export interface ResponseInputText {
  type: "input_text" | "output_text"
  text: string
}

export interface ResponseInputImage {
  type: "input_image"
  image_url?: string | null
  file_id?: string | null
  detail: "low" | "high" | "auto"
}

export interface ResponseInputFile {
  type: "input_file"
  file_data?: string | null
  file_id?: string | null
  filename?: string | null
}

export interface ResponsesResult {
  id: string
  object: "response"
  created_at: number
  model: string
  output: Array<ResponseOutputItem>
  output_text: string
  status: string
  copilot_usage?: CopilotUsage | null
  usage?: ResponseUsage | null
  error: ResponseError | null
  incomplete_details: IncompleteDetails | null
  instructions: string | null
  metadata: Metadata | null
  parallel_tool_calls: boolean
  temperature: number | null
  tool_choice: unknown
  tools: Array<Tool>
  top_p: number | null
}

export interface CopilotUsage {
  total_nano_aiu?: number | null
}

export type Metadata = { [key: string]: string }

export interface IncompleteDetails {
  reason?: "max_output_tokens" | "content_filter"
}

export interface ResponseError {
  code: string | null
  message: string
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseOutputReasoning
  | ResponseOutputFunctionCall
  | ResponseOutputToolSearchCall
  | ResponseOutputToolSearchOutput
  | ResponseOutputWebSearchCall
  | ResponseOutputCompaction

export interface ResponseOutputMessage {
  id: string
  type: "message"
  role: "assistant"
  status: "completed" | "in_progress" | "incomplete"
  content?: Array<ResponseOutputContentBlock>
}

export interface ResponseOutputReasoning {
  id: string
  type: "reasoning"
  summary?: Array<ResponseReasoningBlock>
  encrypted_content?: string
  status?: "completed" | "in_progress" | "incomplete"
}

export interface ResponseReasoningBlock {
  type: string
  text?: string
}

export interface ResponseOutputFunctionCall {
  id?: string
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  status?: "in_progress" | "completed" | "incomplete"
  namespace?: string | null
}

export interface ResponseOutputToolSearchCall {
  id?: string
  type: "tool_search_call"
  call_id: string
  arguments: Record<string, unknown> | string
  execution?: ToolSearchExecution | null
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseOutputToolSearchOutput {
  id?: string
  type: "tool_search_output"
  call_id: string
  tools: Array<Tool>
  execution?: ToolSearchExecution | null
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseOutputWebSearchCall {
  id?: string
  type: "web_search_call"
  action?: {
    query?: string
    queries?: Array<string>
    sources?: Array<{ type?: "url"; url: string }>
    type?: string
    url?: string
    pattern?: string
  }
  status?: "in_progress" | "searching" | "completed" | "failed"
}

export interface ResponseOutputCompaction {
  id: string
  type: "compaction"
  encrypted_content: string
}

export type ResponseOutputContentBlock =
  | ResponseOutputText
  | ResponseOutputRefusal
  | Record<string, unknown>

export interface ResponseOutputText {
  type: "output_text"
  text: string
  annotations: Array<unknown>
}

export interface ResponseOutputRefusal {
  type: "refusal"
  refusal: string
}

export interface ResponseUsage {
  input_tokens: number
  output_tokens?: number
  total_tokens: number
  input_tokens_details?: {
    cached_tokens: number
    cache_write_tokens?: number
  }
  output_tokens_details?: {
    reasoning_tokens: number
  }
}

export type ResponseStreamEvent =
  | ResponseCompletedEvent
  | ResponseIncompleteEvent
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseErrorEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseFailedEvent
  | ResponseOutputItemAddedEvent
  | ResponseOutputItemDoneEvent
  | ResponseContentPartAddedEvent
  | ResponseOutputTextAnnotationAddedEvent
  | ResponseContentPartDoneEvent
  | ResponseWebSearchCallInProgressEvent
  | ResponseWebSearchCallSearchingEvent
  | ResponseWebSearchCallCompletedEvent
  | ResponseReasoningSummaryPartAddedEvent
  | ResponseReasoningSummaryPartDoneEvent
  | ResponseReasoningSummaryTextDeltaEvent
  | ResponseReasoningSummaryTextDoneEvent
  | ResponseTextDeltaEvent
  | ResponseTextDoneEvent

export interface ResponseCompletedEvent {
  copilot_quota_snapshots?: Record<string, CopilotQuotaSnapshot>
  copilot_usage?: CopilotUsage | null
  response: ResponsesResult
  sequence_number: number
  type: "response.completed"
}

export interface ResponseIncompleteEvent {
  copilot_usage?: CopilotUsage | null
  response: ResponsesResult
  sequence_number: number
  type: "response.incomplete"
}

export interface ResponseCreatedEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.created"
}

export interface ResponseInProgressEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.in_progress"
}

export interface ResponseErrorEvent {
  code: string | null
  message: string
  param: string | null
  sequence_number: number
  type: "error"
  error?: {
    type?: string | null
    code: string | null
    message: string
  }
  status_code?: number
  headers?: Record<string, string>
}

export interface ResponseFunctionCallArgumentsDeltaEvent {
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.function_call_arguments.delta"
}

export interface ResponseFunctionCallArgumentsDoneEvent {
  arguments: string
  item_id: string
  name: string
  output_index: number
  sequence_number: number
  type: "response.function_call_arguments.done"
}

export interface ResponseFailedEvent {
  copilot_usage?: CopilotUsage | null
  response: ResponsesResult
  sequence_number: number
  type: "response.failed"
}

export interface ResponseOutputItemAddedEvent {
  item: ResponseOutputItem
  output_index: number
  sequence_number: number
  type: "response.output_item.added"
}

export interface ResponseOutputItemDoneEvent {
  item: ResponseOutputItem
  output_index: number
  sequence_number: number
  type: "response.output_item.done"
}

export interface ResponseContentPartAddedEvent {
  content_index: number
  item_id: string
  output_index: number
  part: ResponseOutputContentBlock
  sequence_number: number
  type: "response.content_part.added"
}

export interface ResponseOutputTextAnnotationAddedEvent {
  annotation: unknown
  annotation_index?: number
  content_index: number
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.output_text.annotation.added"
}

export interface ResponseContentPartDoneEvent {
  content_index: number
  item_id: string
  output_index: number
  part: ResponseOutputContentBlock
  sequence_number: number
  type: "response.content_part.done"
}

export interface ResponseWebSearchCallInProgressEvent {
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.web_search_call.in_progress"
}

export interface ResponseWebSearchCallSearchingEvent {
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.web_search_call.searching"
}

export interface ResponseWebSearchCallCompletedEvent {
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.web_search_call.completed"
}

export interface ResponseReasoningSummaryPartAddedEvent {
  item_id: string
  output_index: number
  part: ResponseReasoningBlock
  sequence_number: number
  summary_index: number
  type: "response.reasoning_summary_part.added"
}

export interface ResponseReasoningSummaryPartDoneEvent {
  item_id: string
  output_index: number
  part: ResponseReasoningBlock
  sequence_number: number
  summary_index: number
  type: "response.reasoning_summary_part.done"
}

export interface ResponseReasoningSummaryTextDeltaEvent {
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  summary_index: number
  type: "response.reasoning_summary_text.delta"
}

export interface ResponseReasoningSummaryTextDoneEvent {
  item_id: string
  output_index: number
  sequence_number: number
  summary_index: number
  text: string
  type: "response.reasoning_summary_text.done"
}

export interface ResponseTextDeltaEvent {
  content_index: number
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.output_text.delta"
}

export interface ResponseTextDoneEvent {
  content_index: number
  item_id: string
  output_index: number
  sequence_number: number
  text: string
  type: "response.output_text.done"
}

export type ResponsesStream = ReturnType<typeof events>
export type CreateResponsesReturn = ResponsesResult | ResponsesStream
export type ResponsesTransport = "http" | "websocket"

const INVALID_RESPONSE_STATUS = 400
const INVALID_RESPONSE_CODE = "invalid_request_body"
const OPAQUE_STATE_ERROR_FRAGMENT = "encrypted content"

type ResponsesStreamChunk = {
  data?: string
  event?: string
  id?: string | number
}

interface ResponsesRequestOptions {
  vision: boolean
  initiator: "agent" | "user"
  subagentMarker?: SubagentMarker | null
  requestId: string
  sessionId?: string
  compactType?: CompactType
  transport?: ResponsesTransport
}

export const createResponses = async (
  payload: ResponsesPayload,
  {
    vision,
    initiator,
    subagentMarker,
    requestId,
    sessionId,
    compactType,
    transport = "http",
  }: ResponsesRequestOptions,
): Promise<CreateResponsesReturn> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers: Record<string, string> = {
    ...copilotHeaders(state, requestId, vision),
    "x-initiator": initiator,
  }

  prepareInteractionHeaders(sessionId, Boolean(subagentMarker), headers)

  prepareForCompact(headers, compactType)

  // service_tier is not supported by github copilot
  payload.service_tier = undefined

  consola.log(`<-- model: ${payload.model}`)

  const effectiveTransport =
    compactType === COMPACT_REQUEST ? "http" : transport

  if (payload.stream === true && effectiveTransport === "websocket") {
    const websocketRequest = prepareResponsesWebSocketRequest(
      payload,
      headers,
      {
        requestId,
        subagentMarker,
      },
    )
    const stream = createPooledResponsesWebSocketStream(websocketRequest)
    return stream
  }

  return await createHttpResponses(payload, headers)
}

const createHttpResponses = async (
  payload: ResponsesPayload,
  headers: Record<string, string>,
): Promise<CreateResponsesReturn> => {
  let response = await postHttpResponses(payload, headers)
  const retryPayload = await createOpaqueStateRetryPayload(payload, response)

  if (retryPayload) {
    consola.warn("Retrying responses request without rejected opaque state")
    response = await postHttpResponses(retryPayload, headers)
  }

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResult
}

const postHttpResponses = async (
  payload: ResponsesPayload,
  headers: Record<string, string>,
): Promise<Response> => {
  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  logCopilotRateLimits(response.headers)

  return response
}

const createOpaqueStateRetryPayload = async (
  payload: ResponsesPayload,
  response: Response,
): Promise<ResponsesPayload | undefined> => {
  if (!(await isOpaqueStateRejection(response))) return undefined
  return removeOpaqueState(payload)
}

const removeOpaqueState = (
  payload: ResponsesPayload,
): ResponsesPayload | undefined => {
  const retryPayload = { ...payload }
  let changed = false

  if (Array.isArray(payload.input)) {
    retryPayload.input = payload.input.filter(
      (item) => !isOpaqueStateItem(item),
    )
    changed = retryPayload.input.length !== payload.input.length
  }

  if (typeof payload.previous_response_id === "string") {
    delete retryPayload.previous_response_id
    changed = true
  }

  return changed ? retryPayload : undefined
}

const isOpaqueStateItem = (item: unknown): boolean => {
  if (typeof item !== "object" || item === null || !("type" in item)) {
    return false
  }
  if (item.type !== "reasoning" && item.type !== "compaction") return false
  return (
    "encrypted_content" in item && typeof item.encrypted_content === "string"
  )
}

const isOpaqueStateRejection = async (response: Response): Promise<boolean> => {
  if (response.status !== INVALID_RESPONSE_STATUS) return false

  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown; message?: unknown }
    }
    return (
      body.error?.code === INVALID_RESPONSE_CODE
      && typeof body.error.message === "string"
      && body.error.message.toLowerCase().includes(OPAQUE_STATE_ERROR_FRAGMENT)
    )
  } catch {
    return false
  }
}

type ResponsesWebSocketPayload = ResponsesPayload & {
  type: "response.create"
  initiator: "agent" | "user"
}

type ResponsesWebSocketRequest =
  PooledWebSocketRequest<ResponsesWebSocketPayload>

export const prepareResponsesWebSocketRequest = (
  payload: ResponsesPayload,
  preparedHeaders: Record<string, string>,
  options: {
    requestId: string
    subagentMarker?: SubagentMarker | null
  },
): ResponsesWebSocketRequest => {
  const initiator = getResponsesWebSocketInitiator(preparedHeaders)

  return {
    headers: copilotWebSocketHeaders(preparedHeaders),
    poolKey: buildResponsesWebSocketPoolKey(payload, options),
    payload: buildResponsesWebSocketPayload(payload, initiator),
    url: buildResponsesWebSocketUrl(copilotBaseUrl(state)),
  }
}

export const buildResponsesWebSocketPoolKey = (
  payload: ResponsesPayload,
  {
    requestId,
    subagentMarker,
  }: {
    requestId: string
    subagentMarker?: SubagentMarker | null
  },
): string => {
  const tokenFingerprint =
    state.copilotToken ?
      createHash("sha256").update(state.copilotToken).digest("hex").slice(0, 16)
    : "missing-token"
  const subagentKey =
    subagentMarker ?
      [
        subagentMarker.session_id,
        subagentMarker.agent_id,
        subagentMarker.agent_type,
      ].join(":")
    : "main"

  return [tokenFingerprint, payload.model, requestId, subagentKey]
    .map(encodePoolKeyPart)
    .join("|")
}

export const getResponsesWebSocketInitiator = (
  preparedHeaders: Record<string, string>,
): "agent" | "user" => {
  const initiator = getHeaderValue(preparedHeaders, "x-initiator")
  return initiator?.toLowerCase() === "agent" ? "agent" : "user"
}

const createPooledResponsesWebSocketStream = (
  request: ResponsesWebSocketRequest,
): ResponsesStream =>
  createResponsesSafeStream(
    createPooledWebSocketStream(request, {
      createChunk: createResponsesWebSocketStreamChunk,
      isTerminalChunk: isTerminalResponsesStreamChunk,
      openErrorMessage: "Failed to create responses websocket",
      streamErrorMessage: "Responses websocket stream error",
      terminalChunkMissingMessage:
        "Responses websocket ended without a terminal response",
    }),
  )

const createResponsesSafeStream = async function* (
  source: AsyncIterable<ResponsesStreamChunk>,
): AsyncGenerator<ResponsesStreamChunk, void, unknown> {
  try {
    yield* source
  } catch (error) {
    yield createResponsesErrorServerSentEventChunk(getErrorMessage(error))
  }
}

export const buildResponsesWebSocketPayload = (
  payload: ResponsesPayload,
  initiator: "agent" | "user",
): ResponsesWebSocketPayload => {
  const websocketPayload: ResponsesWebSocketPayload = {
    ...payload,
    type: "response.create",
    initiator,
  }

  delete websocketPayload.stream
  delete websocketPayload["background"]
  delete websocketPayload.service_tier

  return websocketPayload
}

export const buildResponsesWebSocketUrl = (baseUrl: string): string => {
  return createWebSocketUrl(`${baseUrl.replace(/\/+$/u, "")}/responses`)
}

const getHeaderValue = (
  headers: Record<string, string>,
  headerName: string,
): string | undefined => {
  const normalizedHeaderName = headerName.toLowerCase()
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === normalizedHeaderName,
  )

  return match?.[1]
}

const encodePoolKeyPart = (value: string): string => encodeURIComponent(value)

const createResponsesWebSocketStreamChunk = (
  data: string,
): { data?: string; event?: string; id?: string } => {
  if (data === "[DONE]") {
    return { data }
  }

  try {
    const parsed = JSON.parse(data) as {
      copilot_quota_snapshots?: Record<string, CopilotQuotaSnapshot>
      id?: unknown
      type?: unknown
      error?: {
        code: string | null
        message: string
      }
      code?: string | null
      message?: string
    }
    if (parsed.type === "response.completed") {
      logCopilotQuotaSnapshots(parsed.copilot_quota_snapshots)
    }
    if (parsed.type === "error" && parsed.error) {
      consola.warn("Copilot responses websocket stream error:", parsed.error)
      parsed.code = parsed.error.code
      parsed.message = parsed.error.message
    }
    return {
      event: typeof parsed.type === "string" ? parsed.type : undefined,
      data: JSON.stringify(parsed),
      id: typeof parsed.id === "string" ? parsed.id : undefined,
    }
  } catch {
    return { data }
  }
}

const isTerminalResponsesStreamChunk = (chunk: { data?: string }): boolean => {
  if (!chunk.data || chunk.data === "[DONE]") {
    return false
  }

  try {
    const parsed = JSON.parse(chunk.data) as { type?: unknown }
    return (
      parsed.type === "response.completed"
      || parsed.type === "response.failed"
      || parsed.type === "response.incomplete"
      || parsed.type === "error"
    )
  } catch {
    return false
  }
}

const createResponsesErrorServerSentEventChunk = (
  message: string,
): ResponsesStreamChunk => {
  const errorEvent: ResponseErrorEvent = {
    code: null,
    message,
    param: null,
    sequence_number: 0,
    type: "error",
  }

  return {
    event: errorEvent.type,
    data: JSON.stringify(errorEvent),
  }
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}
