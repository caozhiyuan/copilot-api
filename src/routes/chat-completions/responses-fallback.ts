import type { SSEMessage } from "hono/streaming"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponseFunctionCallOutputItem,
  ResponseFunctionToolCallItem,
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputMessage,
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from "~/services/copilot/create-responses"

import {
  getExtraPromptForModel,
  getReasoningEffortForModel,
} from "~/lib/config"

export const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"
export const RESPONSES_ENDPOINT_PATH = "/responses"

export const translateChatCompletionsToResponsesPayload = (
  payload: ChatCompletionsPayload,
): ResponsesPayload => {
  const systemMessages = payload.messages.filter(
    (m) => m.role === "system" || m.role === "developer",
  )
  const conversationMessages = payload.messages.filter(
    (m) => m.role !== "system" && m.role !== "developer",
  )

  const systemText = systemMessages
    .map((m) => {
      if (typeof m.content === "string") return m.content
      if (Array.isArray(m.content)) {
        return m.content
          .filter((c) => c.type === "text")
          .map((c) => (c as { type: "text"; text: string }).text)
          .join("")
      }
      return ""
    })
    .join("\n")

  const extraPrompt = getExtraPromptForModel(payload.model)
  const rawInstructions = systemText ? systemText + extraPrompt : extraPrompt
  const instructions = rawInstructions.trim() || null

  const input: Array<ResponseInputItem> = []
  for (const msg of conversationMessages) {
    input.push(...translateChatMessage(msg))
  }

  const tools =
    payload.tools?.length ?
      payload.tools.map((t) => ({
        type: "function" as const,
        name: t.function.name,
        description: t.function.description ?? null,
        parameters: t.function.parameters,
        strict: false as null,
      }))
    : null

  let toolChoice: ToolChoiceOptions | ToolChoiceFunction = "auto"
  if (payload.tool_choice) {
    toolChoice =
      typeof payload.tool_choice === "string" ?
        (payload.tool_choice as ToolChoiceOptions)
      : { type: "function", name: payload.tool_choice.function.name }
  }

  return {
    model: payload.model,
    input,
    instructions,
    temperature: 1,
    top_p: payload.top_p ?? null,
    max_output_tokens: payload.max_tokens ?? null,
    tools,
    tool_choice: toolChoice,
    stream: payload.stream ?? null,
    store: false,
    parallel_tool_calls: true,
    reasoning: {
      effort: getReasoningEffortForModel(payload.model),
      summary: "detailed",
    },
    include: ["reasoning.encrypted_content"],
  }
}

type ChatMessage = ChatCompletionsPayload["messages"][number]

const translateChatMessage = (msg: ChatMessage): Array<ResponseInputItem> => {
  if (msg.role === "tool") {
    const item: ResponseFunctionCallOutputItem = {
      type: "function_call_output",
      call_id: msg.tool_call_id ?? "",
      output:
        typeof msg.content === "string" ?
          msg.content
        : JSON.stringify(msg.content),
      status: "completed",
    }
    return [item]
  }

  if (msg.role === "assistant" && msg.tool_calls?.length) {
    const items: Array<ResponseInputItem> = []
    if (msg.content) {
      const text =
        typeof msg.content === "string" ?
          msg.content
        : msg.content
            .filter((c) => c.type === "text")
            .map((c) => (c as { text: string }).text)
            .join("")
      if (text) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        } as ResponseInputMessage)
      }
    }

    for (const tc of msg.tool_calls) {
      const item: ResponseFunctionToolCallItem = {
        type: "function_call",
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: "completed",
      }
      items.push(item)
    }
    return items
  }

  const role = msg.role as "user" | "assistant"
  const content = buildMessageContent(msg, role)
  const responseMsg: ResponseInputMessage = {
    type: "message",
    role,
    content,
  }
  return [responseMsg]
}

const buildMessageContent = (
  msg: ChatMessage,
  role: "user" | "assistant",
): string | Array<ResponseInputContent> => {
  if (typeof msg.content === "string") return msg.content
  if (!Array.isArray(msg.content)) return ""

  const parts: Array<ResponseInputContent> = []
  for (const part of msg.content) {
    if (part.type === "text") {
      parts.push({
        type: role === "assistant" ? "output_text" : "input_text",
        text: part.text,
      } as ResponseInputContent)
    } else {
      parts.push({
        type: "input_image",
        image_url: part.image_url.url,
        detail: part.image_url.detail,
      })
    }
  }
  return parts.length > 0 ? parts : ""
}

export const translateResponsesResultToChatCompletion = (
  result: ResponsesResult,
): ChatCompletionResponse => {
  let content: string | null = null
  const toolCalls: Array<ToolCall> = []

  for (const item of result.output) {
    if (item.type === "message" && item.content) {
      for (const block of item.content) {
        if (
          typeof (block as { text?: unknown }).text === "string"
          && (block as { type?: unknown }).type === "output_text"
        ) {
          content = (content ?? "") + (block as { text: string }).text
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      })
    }
  }

  if (!content && result.output_text) content = result.output_text

  let finishReason: "stop" | "tool_calls" | "length" = "stop"
  if (toolCalls.length > 0) {
    finishReason = "tool_calls"
  } else if (result.status === "incomplete") {
    finishReason = "length"
  }

  return {
    id: result.id,
    object: "chat.completion",
    created: result.created_at,
    model: result.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    ...(result.usage ?
      {
        usage: {
          prompt_tokens: result.usage.input_tokens,
          completion_tokens: result.usage.output_tokens ?? 0,
          total_tokens: result.usage.total_tokens,
        },
      }
    : {}),
  }
}

export interface ResponsesCompletionStreamState {
  messageId: string
  model: string
  created: number
  toolCallCounter: number
  outputIndexToToolCallIndex: Map<number, number>
  finishReason: "stop" | "tool_calls" | "length" | null
}

export const createResponsesCompletionStreamState = (
  model: string,
): ResponsesCompletionStreamState => ({
  messageId: `chatcmpl-${Math.random().toString(36).slice(2)}`,
  model,
  created: Math.floor(Date.now() / 1000),
  toolCallCounter: 0,
  outputIndexToToolCallIndex: new Map(),
  finishReason: null,
})

const makeChunk = (
  state: ResponsesCompletionStreamState,
  delta: ChatCompletionChunk["choices"][0]["delta"],
  finishReason: ChatCompletionChunk["choices"][0]["finish_reason"] = null,
): ChatCompletionChunk => ({
  id: state.messageId,
  object: "chat.completion.chunk",
  created: state.created,
  model: state.model,
  choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
})

export const translateResponsesEventToChunks = (
  event: ResponseStreamEvent,
  state: ResponsesCompletionStreamState,
): Array<SSEMessage> => {
  const sseMessages: Array<SSEMessage> = []

  const emit = (chunk: ChatCompletionChunk) => {
    sseMessages.push({ data: JSON.stringify(chunk) })
  }

  switch (event.type) {
    case "response.created": {
      emit(makeChunk(state, { role: "assistant" }))
      break
    }

    case "response.output_item.added": {
      const item = event.item
      if (item.type === "function_call") {
        const toolCallIndex = state.toolCallCounter++
        state.outputIndexToToolCallIndex.set(event.output_index, toolCallIndex)
        emit(
          makeChunk(state, {
            tool_calls: [
              {
                index: toolCallIndex,
                id: item.call_id,
                type: "function",
                function: { name: item.name, arguments: "" },
              },
            ],
          }),
        )
      }
      break
    }

    case "response.output_text.delta": {
      emit(makeChunk(state, { content: event.delta }))
      break
    }

    case "response.function_call_arguments.delta": {
      const toolCallIndex = state.outputIndexToToolCallIndex.get(
        event.output_index,
      )
      if (toolCallIndex !== undefined) {
        emit(
          makeChunk(state, {
            tool_calls: [
              { index: toolCallIndex, function: { arguments: event.delta } },
            ],
          }),
        )
      }
      break
    }

    case "response.completed": {
      const hasToolCalls = event.response.output.some(
        (item) => item.type === "function_call",
      )
      state.finishReason = hasToolCalls ? "tool_calls" : "stop"
      emit(makeChunk(state, {}, state.finishReason))
      sseMessages.push({ data: "[DONE]" })
      break
    }

    case "response.incomplete": {
      state.finishReason = "length"
      emit(makeChunk(state, {}, "length"))
      sseMessages.push({ data: "[DONE]" })
      break
    }

    case "response.failed": {
      state.finishReason = "stop"
      emit(makeChunk(state, {}, "stop"))
      sseMessages.push({ data: "[DONE]" })
      break
    }

    default: {
      break
    }
  }

  return sseMessages
}
