/**
 * Translate Responses API streaming events back to Chat Completions
 * chunked streaming format (SSE with `chat.completion.chunk` objects).
 *
 * This is the completions-side counterpart of the Anthropic-to-Responses
 * stream translator in routes/messages/responses-stream-translation.ts.
 */

import type {
  ChatCompletionChunk,
  CopilotUsage,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponseOutputItem,
  ResponsesResult,
  ResponseStreamEvent,
  ResponseUsage,
} from "~/services/copilot/create-responses"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CompletionsStreamState {
  responseId: string
  createdAt: number
  model: string
  started: boolean
}

interface SSEMessage {
  data?: string
  event?: string
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const createCompletionsStreamState = (): CompletionsStreamState => ({
  responseId: "",
  createdAt: Math.floor(Date.now() / 1000),
  model: "",
  started: false,
})

/**
 * Translate a single Responses API stream event into zero or more
 * Chat Completions chunk SSE messages.
 */
export const translateResponsesStreamEventToCompletions = (
  event: ResponseStreamEvent,
  state: CompletionsStreamState,
): Array<SSEMessage> => {
  const messages: Array<SSEMessage> = []

  // Capture metadata from response envelope events
  if ("response" in event && event.response) {
    state.responseId = event.response.id
    state.createdAt = event.response.created_at
    state.model = event.response.model
  }

  switch (event.type) {
    case "response.output_item.added": {
      handleOutputItemAdded(event.item, event.output_index, state, messages)
      break
    }

    case "response.output_text.delta": {
      emitRoleChunkIfNeeded(state, messages)
      messages.push(
        createChunkMessage(state, {
          delta: { content: event.delta },
        }),
      )
      break
    }

    case "response.function_call_arguments.delta": {
      if (event.output_index === undefined) {
        break
      }
      emitRoleChunkIfNeeded(state, messages)
      messages.push(
        createChunkMessage(state, {
          delta: {
            tool_calls: [
              {
                index: event.output_index,
                type: "function",
                function: {
                  arguments: event.delta ?? "",
                },
              },
            ],
          },
        }),
      )
      break
    }

    case "response.completed":
    case "response.incomplete": {
      const response = event.response
      const hasFunctionCalls = response.output.some(
        (item: ResponseOutputItem) => item.type === "function_call",
      )
      messages.push(
        createChunkMessage(state, {
          delta: {},
          finishReason: getFinishReason(response, hasFunctionCalls),
          usage: translateUsage(response.usage),
          copilotUsage: event.copilot_usage,
        }),
      )
      messages.push({ data: "[DONE]" })
      break
    }

    case "response.failed": {
      messages.push(
        createChunkMessage(state, {
          delta: {},
          finishReason: "stop",
        }),
      )
      messages.push({ data: "[DONE]" })
      break
    }

    // Reasoning, web search, content part events - no completions equivalent,
    // silently skip them.
    default: {
      break
    }
  }

  return messages
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const handleOutputItemAdded = (
  item: ResponseOutputItem,
  outputIndex: number,
  state: CompletionsStreamState,
  messages: Array<SSEMessage>,
): void => {
  if (item.type === "message") {
    emitRoleChunkIfNeeded(state, messages)
    return
  }

  if (item.type === "function_call") {
    const fc = item
    state.started = true
    messages.push(
      createChunkMessage(state, {
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: outputIndex,
              id: fc.call_id,
              type: "function",
              function: {
                name: fc.name,
                arguments: "",
              },
            },
          ],
        },
      }),
    )
  }
}

const emitRoleChunkIfNeeded = (
  state: CompletionsStreamState,
  messages: Array<SSEMessage>,
): void => {
  if (state.started) {
    return
  }
  state.started = true
  messages.push(createChunkMessage(state, { delta: { role: "assistant" } }))
}

interface CreateChunkOptions {
  delta: ChatCompletionChunk["choices"][0]["delta"]
  finishReason?: ChatCompletionChunk["choices"][0]["finish_reason"]
  usage?: ChatCompletionChunk["usage"]
  copilotUsage?: CopilotUsage | null
}

const createChunkMessage = (
  state: CompletionsStreamState,
  { delta, finishReason = null, usage, copilotUsage }: CreateChunkOptions,
): SSEMessage => {
  const chunk: ChatCompletionChunk = {
    id: state.responseId,
    object: "chat.completion.chunk",
    created: state.createdAt,
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    ...(usage ? { usage } : {}),
    ...(copilotUsage ? { copilot_usage: copilotUsage } : {}),
  }

  return { data: JSON.stringify(chunk) }
}

// ---------------------------------------------------------------------------
// Usage and finish reason (shared with non-stream translation)
// ---------------------------------------------------------------------------

const translateUsage = (
  usage: ResponseUsage | null | undefined,
): ChatCompletionChunk["usage"] | undefined => {
  if (!usage) {
    return undefined
  }
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens,
    ...(usage.input_tokens_details?.cached_tokens !== undefined && {
      prompt_tokens_details: {
        cached_tokens: usage.input_tokens_details.cached_tokens,
      },
    }),
  }
}

const getFinishReason = (
  response: ResponsesResult,
  hasFunctionCalls: boolean,
): "stop" | "length" | "tool_calls" | "content_filter" => {
  if (hasFunctionCalls) {
    return "tool_calls"
  }
  if (response.incomplete_details?.reason === "max_output_tokens") {
    return "length"
  }
  if (response.incomplete_details?.reason === "content_filter") {
    return "content_filter"
  }
  return "stop"
}
