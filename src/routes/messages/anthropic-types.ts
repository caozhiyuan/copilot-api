// Anthropic API Types

export interface AnthropicMessagesPayload {
  model: string
  messages: Array<AnthropicInputMessage>
  cache_control?: AnthropicCacheControl | null
  system?: string | Array<AnthropicTextBlock>
  stop_sequences?: Array<string>
  stream?: boolean
  top_p?: number
  top_k?: number
  tools?: Array<AnthropicTool>
  tool_choice?: {
    type: "auto" | "any" | "tool" | "none"
    name?: string
  }
  max_tokens: number
  thinking?: {
    type: "enabled" | "adaptive"
    budget_tokens?: number
    display?: string
  }
  service_tier?: "auto" | "standard_only"
  output_config?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "max"
  }
  metadata?: {
    user_id?: string
  }
  temperature?: number
}

export interface AnthropicCacheControl {
  type: "ephemeral"
  ttl?: "5m" | "1h"
  scope?: string
  [key: string]: unknown
}

export interface AnthropicTextBlock {
  type: "text"
  text: string
  cache_control?: AnthropicCacheControl | null
}

export interface AnthropicImageBlock {
  type: "image"
  source: {
    type: "base64"
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    data: string
  }
  cache_control?: AnthropicCacheControl | null
}

export interface AnthropicDocumentBlock {
  type: "document"
  source: {
    type: "base64"
    media_type: "application/pdf"
    data: string
  }
  title?: string | null
  cache_control?: AnthropicCacheControl | null
}

export interface AnthropicToolReferenceBlock {
  type: "tool_reference"
  tool_name: string
  cache_control?: AnthropicCacheControl | null
}

export type AnthropicToolResultContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolReferenceBlock

export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | Array<AnthropicToolResultContentBlock>
  is_error?: boolean
  cache_control?: AnthropicCacheControl | null
}

export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
  cache_control?: AnthropicCacheControl | null
}

export interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
  signature: string
}

export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolResultBlock

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock

export interface AnthropicUserMessage {
  role: "user"
  content: string | Array<AnthropicUserContentBlock>
}

export interface AnthropicAssistantMessage {
  role: "assistant"
  content: string | Array<AnthropicAssistantContentBlock>
}

export interface AnthropicSystemMessage {
  role: "system"
  content: string | Array<AnthropicTextBlock>
}

export type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage
export type AnthropicInputMessage = AnthropicMessage | AnthropicSystemMessage

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  defer_loading?: boolean
  cache_control?: AnthropicCacheControl | null
  // Server-side tool fields (e.g. web_search_20250305). Server tools carry a
  // `type` and omit `input_schema`; these stay optional so the same interface
  // can describe both custom and server tools without rippling type changes.
  type?: string
  max_uses?: number
  allowed_domains?: Array<string>
  blocked_domains?: Array<string>
  user_location?: Record<string, unknown>
}

// --- Web search result blocks (Anthropic server tool shape) ---------------
// Emitted in the assistant response when the proxy fulfills a web_search tool.

export interface AnthropicWebSearchResultItem {
  type: "web_search_result"
  url: string
  title: string
  page_age?: string | null
  encrypted_content?: string
}

export interface AnthropicServerToolUseBlock {
  type: "server_tool_use"
  id: string
  name: "web_search"
  input: Record<string, unknown>
}

export interface AnthropicWebSearchToolResultErrorBlock {
  type: "web_search_tool_result_error"
  error_code: string
}

export interface AnthropicWebSearchToolResultBlock {
  type: "web_search_tool_result"
  tool_use_id: string
  content:
    | Array<AnthropicWebSearchResultItem>
    | AnthropicWebSearchToolResultErrorBlock
}

export type AnthropicWebSearchContentBlock =
  | AnthropicServerToolUseBlock
  | AnthropicWebSearchToolResultBlock

export interface AnthropicResponse {
  id: string
  type: "message"
  role: "assistant"
  content: Array<AnthropicAssistantContentBlock>
  model: string
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    service_tier?: "standard" | "priority" | "batch"
  }
}

export type AnthropicResponseContentBlock = AnthropicAssistantContentBlock

// Anthropic Stream Event Types
export interface AnthropicMessageStartEvent {
  type: "message_start"
  message: Omit<
    AnthropicResponse,
    "content" | "stop_reason" | "stop_sequence"
  > & {
    content: []
    stop_reason: null
    stop_sequence: null
  }
}

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start"
  index: number
  content_block:
    | { type: "text"; text: string }
    | (Omit<AnthropicToolUseBlock, "input"> & {
        input: Record<string, unknown>
      })
    | { type: "thinking"; thinking: string }
}

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta"
  index: number
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string }
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop"
  index: number
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta"
  delta: {
    stop_reason?: AnthropicResponse["stop_reason"]
    stop_sequence?: string | null
  }
  usage?: {
    input_tokens?: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export interface AnthropicMessageStopEvent {
  type: "message_stop"
}

export interface AnthropicPingEvent {
  type: "ping"
}

export interface AnthropicErrorEvent {
  type: "error"
  error: {
    type: string
    message: string
  }
}

export type AnthropicStreamEventData =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent

// State for streaming translation
export interface AnthropicStreamState {
  messageStartSent: boolean
  contentBlockIndex: number
  contentBlockOpen: boolean
  thinkingBlockOpen: boolean
  pendingMessageDelta?: AnthropicMessageDeltaEvent
  deferredContent?: string
  toolCalls: {
    [openAIToolIndex: number]: {
      id: string
      name: string
      anthropicBlockIndex: number
    }
  }
}
