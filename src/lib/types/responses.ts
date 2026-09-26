// OpenAI Responses API Types

import type { events } from "fetch-event-stream"

import type { CopilotQuotaSnapshot } from "~/lib/copilot-rate-limit"

export interface ResponsesPayload {
  model: string
  instructions?: string | null
  input?: string | Array<ResponseInputItem>
  tools?: Array<Tool> | null
  tool_choice?: ToolChoiceOptions | ToolChoiceFunction | ToolChoiceCustom
  temperature?: number | null
  top_p?: number | null
  max_output_tokens?: number | null
  metadata?: Metadata | null
  client_metadata?: Record<string, string> | null
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

export interface ToolChoiceCustom {
  name: string
  type: "custom"
}

export type Tool =
  | FunctionTool
  | CustomTool
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

export interface CustomTool {
  type: "custom"
  name: string
  description?: string | null
  format?:
    | { type: "text" }
    | { type: "grammar"; syntax: "lark" | "regex"; definition: string }
    | null
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

export interface ResponseInputAgentMessage {
  id?: string
  type: "agent_message"
  author: string
  recipient: string
  content: Array<ResponseInputAgentMessageContent>
}

export type ResponseInputAgentMessageContent =
  | {
      type: "input_text"
      text: string
    }
  | {
      type: "encrypted_content"
      encrypted_content: string
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

export interface ResponseCustomToolCallItem {
  type: "custom_tool_call"
  call_id: string
  name: string
  input: string
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseCustomToolCallOutputItem {
  type: "custom_tool_call_output"
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
  | ResponseInputAgentMessage
  | ResponseFunctionToolCallItem
  | ResponseFunctionCallOutputItem
  | ResponseCustomToolCallItem
  | ResponseCustomToolCallOutputItem
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
  detail?: "low" | "high" | "auto"
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
  | ResponseOutputCustomToolCall
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

export interface ResponseOutputCustomToolCall {
  id: string
  type: "custom_tool_call"
  call_id: string
  name: string
  input: string
  status?: "in_progress" | "completed" | "incomplete"
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
  cost?: number
}

export type ResponseStreamEvent =
  | ResponseCompletedEvent
  | ResponseIncompleteEvent
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseErrorEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseCustomToolCallInputDeltaEvent
  | ResponseCustomToolCallInputDoneEvent
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

export interface ResponseCustomToolCallInputDeltaEvent {
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.custom_tool_call_input.delta"
}

export interface ResponseCustomToolCallInputDoneEvent {
  input: string
  item_id: string
  name: string
  output_index: number
  sequence_number: number
  type: "response.custom_tool_call_input.done"
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
