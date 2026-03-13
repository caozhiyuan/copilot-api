import consola from "consola"
import { events } from "fetch-event-stream"

import type { AccountContext } from "~/lib/types/account"
import type { SubagentMarker } from "~/routes/messages/subagent-marker"

import {
  copilotBaseUrl,
  copilotHeaders,
  prepareInteractionHeaders,
} from "~/lib/api-config"
import { getReasoningEffortForModel, isForceAgentEnabled } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { accountFromState } from "~/lib/state"

function isGpt5MiniFamily(modelId: string): boolean {
  return modelId === "gpt-5-mini" || modelId.startsWith("gpt-5-mini-")
}

function applyDefaultReasoningEffort(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  if (!isGpt5MiniFamily(payload.model)) return payload

  // Only inject when omitted/null; allow callers to explicitly override.
  if (
    payload.reasoning_effort !== null
    && payload.reasoning_effort !== undefined
  )
    return payload

  return {
    ...payload,
    reasoning_effort: getReasoningEffortForModel("gpt-5-mini"),
  }
}

export const getChatInitiator = (
  messages: Array<Message>,
): "agent" | "user" => {
  if (isForceAgentEnabled()) {
    const hasAgent = messages.some((msg) =>
      ["assistant", "tool"].includes(msg.role),
    )
    return hasAgent ? "agent" : "user"
  }

  const lastMessage = messages.at(-1)
  if (!lastMessage) return "user"

  return ["assistant", "tool"].includes(lastMessage.role) ? "agent" : "user"
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  account?: AccountContext,
  options?: {
    upstreamRequestId?: string
    initiator?: "agent" | "user"
    subagentMarker?: SubagentMarker | null
    sessionId?: string
  },
) => {
  const ctx = account ?? accountFromState()
  if (!ctx.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  const initiator = options?.initiator ?? getChatInitiator(payload.messages)

  // Build headers and add x-initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(ctx, enableVision, options?.upstreamRequestId),
    "x-initiator": options?.subagentMarker ? "agent" : initiator,
  }

  prepareInteractionHeaders(
    options?.sessionId,
    Boolean(options?.subagentMarker),
    headers,
  )

  const upstreamPayload = applyDefaultReasoningEffort(payload)

  const response = await fetch(`${copilotBaseUrl(ctx)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamPayload),
  })

  if (!response.ok) {
    consola.error("Failed to create chat completions", response)
    throw new HTTPError("Failed to create chat completions", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

export interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
  reasoning_text?: string | null
  reasoning_opaque?: string | null
}

export interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
  reasoning_effort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | null
  thinking_budget?: number
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
  reasoning_text?: string | null
  reasoning_opaque?: string | null
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
