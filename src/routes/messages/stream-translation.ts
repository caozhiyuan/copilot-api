import {
  type ChatCompletionChunk,
  type Choice,
  type Delta,
} from "~/lib/types/chat-completions"

import {
  type AnthropicMessageDeltaEvent,
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "~/lib/types/anthropic"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

function isToolBlockOpen(state: AnthropicStreamState): boolean {
  if (!state.contentBlockOpen) {
    return false
  }
  // Check if the current block index corresponds to any known tool call
  return Object.values(state.toolCalls).some(
    (tc) => tc.anthropicBlockIndex === state.contentBlockIndex,
  )
}

export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  if (chunk.choices.length === 0) {
    // Empty-choices chunks without usage are metadata-only events (e.g.
    // inference cost) that may arrive before the final usage chunk. Only
    // complete the pending message when usage is present; otherwise wait
    // for the usage chunk or the final stream flush.
    if (chunk.usage) {
      completePendingMessage(state, events, chunk)
    }
    return events
  }

  const choice = chunk.choices[0]
  const { delta } = choice

  handleMessageStart(state, events, chunk)

  handleThinkingText(delta, state, events)

  handleContent(delta, state, events)

  handleToolCalls(delta, state, events)

  handleFinish(choice, state, { events, chunk })

  return events
}

export function flushPendingAnthropicStreamEvents(
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []
  completePendingMessage(state, events)
  return events
}

function completePendingMessage(
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
  chunk?: ChatCompletionChunk,
): void {
  if (!state.pendingMessageDelta) {
    return
  }

  if (chunk?.usage) {
    state.pendingMessageDelta.usage = getAnthropicUsageFromOpenAIChunk(chunk)
  }

  events.push(state.pendingMessageDelta, {
    type: "message_stop",
  })
  state.pendingMessageDelta = undefined
  state.messageCompleted = true
}

function handleFinish(
  choice: Choice,
  state: AnthropicStreamState,
  context: {
    events: Array<AnthropicStreamEventData>
    chunk: ChatCompletionChunk
  },
) {
  const { events, chunk } = context
  if (choice.finish_reason && choice.finish_reason.length > 0) {
    if (state.contentBlockOpen) {
      const toolBlockOpen = isToolBlockOpen(state)
      context.events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockOpen = false
      state.contentBlockIndex++
      if (!toolBlockOpen) {
        handleReasoningOpaque(choice.delta, events, state)
      }
    }

    flushDeferredContent(state, events)

    state.pendingMessageDelta = {
      type: "message_delta",
      delta: {
        stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
        stop_sequence: null,
      },
      usage: getAnthropicUsageFromOpenAIChunk(chunk),
    }
    if (chunk.usage) {
      completePendingMessage(state, events, chunk)
    }
  }
}

function getAnthropicUsageFromOpenAIChunk(
  chunk: ChatCompletionChunk,
): NonNullable<AnthropicMessageDeltaEvent["usage"]> {
  const { cachedTokens, cacheCreationTokens, inputTokens } =
    getOpenAIChunkUsageTokens(chunk)

  return {
    input_tokens: inputTokens,
    output_tokens: chunk.usage?.completion_tokens ?? 0,
    ...(chunk.usage?.prompt_tokens_details?.cache_creation_input_tokens
      !== undefined && {
      cache_creation_input_tokens: cacheCreationTokens,
    }),
    ...(chunk.usage?.prompt_tokens_details?.cached_tokens !== undefined && {
      cache_read_input_tokens: cachedTokens,
    }),
  }
}

function getOpenAIChunkUsageTokens(chunk: ChatCompletionChunk): {
  cacheCreationTokens: number
  cachedTokens: number
  inputTokens: number
} {
  const promptTokens = chunk.usage?.prompt_tokens ?? 0
  const cachedTokens = chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0
  const cacheCreationTokens =
    chunk.usage?.prompt_tokens_details?.cache_creation_input_tokens ?? 0

  return {
    cacheCreationTokens,
    cachedTokens,
    inputTokens: Math.max(0, promptTokens - cachedTokens - cacheCreationTokens),
  }
}

function handleToolCalls(
  delta: Delta,
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
) {
  if (delta.tool_calls && delta.tool_calls.length > 0) {
    closeThinkingBlockIfOpen(state, events)

    handleReasoningOpaqueInToolCalls(state, events, delta)

    for (const toolCall of delta.tool_calls) {
      const existing = state.toolCalls[toolCall.index] as
        | AnthropicStreamState["toolCalls"][number]
        | undefined
      const info = existing ?? {
        id: "",
        name: "",
        anthropicBlockIndex: -1,
        pendingArgs: [],
      }
      if (!existing) {
        state.toolCalls[toolCall.index] = info
      }

      // Copilot may split a tool call's id and function name across chunks.
      if (toolCall.id) {
        info.id = toolCall.id
      }
      if (toolCall.function?.name) {
        info.name = toolCall.function.name
      }

      // Open the tool_use block only after both identity fields are known.
      if (info.anthropicBlockIndex === -1 && info.id && info.name) {
        if (state.contentBlockOpen) {
          events.push({
            type: "content_block_stop",
            index: state.contentBlockIndex,
          })
          state.contentBlockIndex++
          state.contentBlockOpen = false
        }

        info.anthropicBlockIndex = state.contentBlockIndex

        events.push({
          type: "content_block_start",
          index: info.anthropicBlockIndex,
          content_block: {
            type: "tool_use",
            id: info.id,
            name: info.name,
            input: {},
          },
        })
        state.contentBlockOpen = true

        if (info.pendingArgs.length > 0) {
          events.push({
            type: "content_block_delta",
            index: info.anthropicBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: info.pendingArgs.join(""),
            },
          })
          info.pendingArgs.length = 0
        }
      }

      if (toolCall.function?.arguments) {
        if (info.anthropicBlockIndex === -1) {
          info.pendingArgs.push(toolCall.function.arguments)
        } else {
          events.push({
            type: "content_block_delta",
            index: info.anthropicBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: toolCall.function.arguments,
            },
          })
        }
      }
    }
  }
}

function handleReasoningOpaqueInToolCalls(
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
  delta: Delta,
) {
  if (state.contentBlockOpen && !isToolBlockOpen(state)) {
    events.push({
      type: "content_block_stop",
      index: state.contentBlockIndex,
    })
    state.contentBlockIndex++
    state.contentBlockOpen = false
  }
  handleReasoningOpaque(delta, events, state)
}

function handleContent(
  delta: Delta,
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
) {
  if (delta.content && delta.content.length > 0) {
    closeThinkingBlockIfOpen(state, events)

    if (
      isToolBlockOpen(state)
      || hasToolCallDelta(delta)
      || hasPendingToolCall(state)
    ) {
      state.deferredContent = `${state.deferredContent ?? ""}${delta.content}`
      return
    }

    if (!state.contentBlockOpen) {
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "text",
          text: "",
        },
      })
      state.contentBlockOpen = true
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "text_delta",
        text: delta.content,
      },
    })
  }

  // Preserve opaque reasoning signatures on Anthropic-compatible streams.
  if (
    delta.content === ""
    && delta.reasoning_opaque
    && delta.reasoning_opaque.length > 0
    && state.thinkingBlockOpen
  ) {
    events.push(
      {
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: {
          type: "signature_delta",
          signature: delta.reasoning_opaque,
        },
      },
      {
        type: "content_block_stop",
        index: state.contentBlockIndex,
      },
    )
    state.contentBlockIndex++
    state.thinkingBlockOpen = false
  }
}

function hasToolCallDelta(delta: Delta): boolean {
  return Boolean(delta.tool_calls && delta.tool_calls.length > 0)
}

function hasPendingToolCall(state: AnthropicStreamState): boolean {
  return Object.values(state.toolCalls).some(
    (toolCall) => toolCall.anthropicBlockIndex === -1,
  )
}

function flushDeferredContent(
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  if (!state.deferredContent) {
    return
  }

  if (!state.contentBlockOpen) {
    events.push({
      type: "content_block_start",
      index: state.contentBlockIndex,
      content_block: {
        type: "text",
        text: "",
      },
    })
    state.contentBlockOpen = true
  }

  events.push(
    {
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "text_delta",
        text: state.deferredContent,
      },
    },
    {
      type: "content_block_stop",
      index: state.contentBlockIndex,
    },
  )
  state.deferredContent = undefined
  state.contentBlockOpen = false
  state.contentBlockIndex++
}

function handleMessageStart(
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
  chunk: ChatCompletionChunk,
) {
  if (!state.messageStartSent) {
    const { cachedTokens, cacheCreationTokens, inputTokens } =
      getOpenAIChunkUsageTokens(chunk)

    events.push({
      type: "message_start",
      message: {
        id: chunk.id,
        type: "message",
        role: "assistant",
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0, // Will be updated in message_delta when finished
          ...(chunk.usage?.prompt_tokens_details?.cache_creation_input_tokens
            !== undefined && {
            cache_creation_input_tokens: cacheCreationTokens,
          }),
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens
            !== undefined && {
            cache_read_input_tokens: cachedTokens,
          }),
        },
      },
    })
    state.messageStartSent = true
  }
}

function handleReasoningOpaque(
  delta: Delta,
  events: Array<AnthropicStreamEventData>,
  state: AnthropicStreamState,
) {
  if (delta.reasoning_opaque && delta.reasoning_opaque.length > 0) {
    events.push(
      {
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "thinking",
          thinking: "",
        },
      },
      {
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: {
          type: "thinking_delta",
          thinking: "",
        },
      },
      {
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: {
          type: "signature_delta",
          signature: delta.reasoning_opaque,
        },
      },
      {
        type: "content_block_stop",
        index: state.contentBlockIndex,
      },
    )
    state.contentBlockIndex++
  }
}

function handleThinkingText(
  delta: Delta,
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
) {
  const reasoningText =
    delta.reasoning_text ?? delta.reasoning_content ?? delta.reasoning
  if (reasoningText && reasoningText.length > 0) {
    // compatible with copilot API returning content->reasoning_text->reasoning_opaque in different deltas
    // this is an extremely abnormal situation, probably a server-side bug
    // Some upstreams emit this rarely at the end of a reasoning block.
    if (state.contentBlockOpen) {
      delta.content = reasoningText
      delta.reasoning_text = undefined
      delta.reasoning_content = undefined
      delta.reasoning = undefined
      return
    }

    if (!state.thinkingBlockOpen) {
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "thinking",
          thinking: "",
        },
      })
      state.thinkingBlockOpen = true
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "thinking_delta",
        thinking: reasoningText,
      },
    })
  }
}

function closeThinkingBlockIfOpen(
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  if (state.thinkingBlockOpen) {
    events.push(
      {
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: {
          type: "signature_delta",
          signature: "",
        },
      },
      {
        type: "content_block_stop",
        index: state.contentBlockIndex,
      },
    )
    state.contentBlockIndex++
    state.thinkingBlockOpen = false
  }
}

export function translateErrorToAnthropicErrorEvent(): AnthropicStreamEventData {
  return {
    type: "error",
    error: {
      type: "api_error",
      message:
        "An unexpected error occurred during streaming, retry your request.",
    },
  }
}
