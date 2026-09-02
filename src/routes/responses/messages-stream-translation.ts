import type {
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicUsage,
} from "~/lib/types/anthropic"
import type {
  ResponseOutputCustomToolCall,
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputReasoning,
  ResponsesResult,
  ResponseStreamEvent,
} from "~/lib/types/responses"

import { CustomToolInputStreamDecoder } from "./custom-tool-input-stream-decoder"
import {
  createMessagesBackedResponsesResult,
  encodeMessagesCompaction,
  markMessagesReasoningId,
  resolveToolDescriptor,
  ResponsesMessagesTranslationError,
  toResponseId,
  translateAnthropicUsage,
  type MessagesResponseTranslationContext,
} from "./messages-translation"

const EMPTY_SIGNATURE_ENCRYPTED_CONTENT = ""

interface MessagesStreamChunk {
  data?: string
  event?: string
}

interface StreamOutputState<T extends ResponseOutputItem> {
  done: boolean
  item: T
  outputIndex: number
}

interface StreamReasoningState
  extends StreamOutputState<ResponseOutputReasoning> {
  signature: string
  summaryStarted: boolean
  text: string
  type: "reasoning"
}

interface StreamMessageState extends StreamOutputState<ResponseOutputMessage> {
  text: string
  type: "message"
}

interface StreamFunctionToolState
  extends StreamOutputState<ResponseOutputFunctionCall> {
  type: "function_tool"
}

interface StreamCustomToolState
  extends StreamOutputState<ResponseOutputCustomToolCall> {
  decoder: CustomToolInputStreamDecoder
  type: "custom_tool"
}

type StreamBlockState =
  | StreamCustomToolState
  | StreamFunctionToolState
  | StreamMessageState
  | StreamReasoningState

interface TranslationState {
  blocks: Map<number, StreamBlockState>
  compactionText: string
  compactionToolCall: boolean
  context: MessagesResponseTranslationContext
  copilotUsage: ResponsesResult["copilot_usage"]
  createdAt: number
  initialized: boolean
  messageStopped: boolean
  model: string
  nextOutputIndex: number
  outputText: string
  responseId: string
  sequence: number
  stopReason: AnthropicResponse["stop_reason"]
  usage: AnthropicUsage
}

export async function* translateMessagesStream(
  chunks: AsyncIterable<MessagesStreamChunk>,
  context: MessagesResponseTranslationContext,
): AsyncGenerator<ResponseStreamEvent> {
  const state = createTranslationState(context)

  try {
    for await (const chunk of chunks) {
      if (!chunk.data || chunk.data === "[DONE]") continue

      const event = parseAnthropicEvent(chunk.data)
      if (event.type === "ping") continue
      if (event.type === "error") {
        throw new ResponsesMessagesTranslationError(event.error.message, 502)
      }

      if (!state.initialized) {
        initializeState(state, event)
        yield createLifecycleEvent(state, "response.created")
        yield createLifecycleEvent(state, "response.in_progress")
      }

      for (const translated of translateEvent(state, event)) {
        yield translated
      }
      if (state.messageStopped) break
    }

    if (!state.initialized) {
      throw new ResponsesMessagesTranslationError(
        "Messages API returned an empty stream",
        502,
      )
    }

    if (!state.messageStopped) {
      // The upstream messages stream ended without a message_stop event,
      // which means it was interrupted. Surface a failure instead of
      // synthesizing a completed response.
      throw new ResponsesMessagesTranslationError(
        "Messages stream ended without a message_stop event",
        502,
      )
    }
  } catch (error) {
    if (!state.initialized) {
      // No lifecycle events reached the client yet. Emit response.created and
      // response.in_progress before the failure so clients tracking the
      // lifecycle receive a protocol-valid stream instead of a silent close.
      yield createLifecycleEvent(state, "response.created")
      yield createLifecycleEvent(state, "response.in_progress")
    }
    yield createErrorEvent(state, error)
    yield createFailedEvent(state, error)
  }
}

export function responsesResultToStreamEvents(
  result: ResponsesResult,
): Array<ResponseStreamEvent> {
  let sequence = 0
  const next = (value: Record<string, unknown>): ResponseStreamEvent =>
    ({ ...value, sequence_number: sequence++ }) as ResponseStreamEvent
  const inProgress = {
    ...result,
    output: [],
    output_text: "",
    status: "in_progress",
    usage: null,
  }
  const events: Array<ResponseStreamEvent> = [
    next({ type: "response.created", response: inProgress }),
    next({ type: "response.in_progress", response: inProgress }),
  ]

  for (const [outputIndex, item] of result.output.entries()) {
    events.push(
      next({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...structuredClone(item), status: "in_progress" },
      }),
    )

    if (item.type === "message") {
      const textPart = item.content?.find((part) => part.type === "output_text")
      if (textPart?.type === "output_text") {
        events.push(
          next({
            type: "response.content_part.added",
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }),
          next({
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            delta: textPart.text,
          }),
          next({
            type: "response.output_text.done",
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            text: textPart.text,
          }),
          next({
            type: "response.content_part.done",
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            part: textPart,
          }),
        )
      }
    } else if (item.type === "reasoning") {
      const text = item.summary?.[0]?.text
      if (text) {
        const part = { type: "summary_text", text }
        events.push(
          next({
            type: "response.reasoning_summary_part.added",
            item_id: item.id,
            output_index: outputIndex,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          }),
          next({
            type: "response.reasoning_summary_text.delta",
            item_id: item.id,
            output_index: outputIndex,
            summary_index: 0,
            delta: text,
          }),
          next({
            type: "response.reasoning_summary_text.done",
            item_id: item.id,
            output_index: outputIndex,
            summary_index: 0,
            text,
          }),
          next({
            type: "response.reasoning_summary_part.done",
            item_id: item.id,
            output_index: outputIndex,
            summary_index: 0,
            part,
          }),
        )
      }
    } else if (item.type === "function_call") {
      if (item.arguments) {
        events.push(
          next({
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: outputIndex,
            delta: item.arguments,
          }),
        )
      }
      events.push(
        next({
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: outputIndex,
          name: item.name,
          arguments: item.arguments,
        }),
      )
    } else if (item.type === "custom_tool_call") {
      if (item.input) {
        events.push(
          next({
            type: "response.custom_tool_call_input.delta",
            item_id: item.id,
            output_index: outputIndex,
            delta: item.input,
          }),
        )
      }
      events.push(
        next({
          type: "response.custom_tool_call_input.done",
          item_id: item.id,
          output_index: outputIndex,
          name: item.name,
          input: item.input,
        }),
      )
    }

    events.push(
      next({
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      }),
    )
  }

  events.push(
    next({
      type:
        result.status === "incomplete" ? "response.incomplete"
        : result.status === "failed" ? "response.failed"
        : "response.completed",
      response: { ...result, output: [] },
      copilot_usage: result.copilot_usage,
    }),
  )
  return events
}

function createTranslationState(
  context: MessagesResponseTranslationContext,
): TranslationState {
  return {
    blocks: new Map(),
    compactionText: "",
    compactionToolCall: false,
    context,
    copilotUsage: null,
    createdAt: Math.floor(Date.now() / 1000),
    initialized: false,
    messageStopped: false,
    model: context.publicModel,
    nextOutputIndex: 0,
    outputText: "",
    responseId: `resp_${Date.now().toString(36)}`,
    sequence: 0,
    stopReason: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}

function initializeState(
  state: TranslationState,
  event: Exclude<AnthropicStreamEventData, { type: "error" | "ping" }>,
): void {
  if (event.type === "message_start") {
    state.responseId = toResponseId(event.message.id)
    state.model = event.message.model
    state.usage = { ...event.message.usage }
    state.copilotUsage = event.message.copilot_usage ?? null
  }
  state.initialized = true
}

function* translateEvent(
  state: TranslationState,
  event: Exclude<AnthropicStreamEventData, { type: "error" | "ping" }>,
): Generator<ResponseStreamEvent> {
  switch (event.type) {
    case "message_start": {
      state.usage = mergeUsage(state.usage, event.message.usage)
      state.copilotUsage = event.message.copilot_usage ?? state.copilotUsage
      break
    }
    case "content_block_start": {
      for (const translated of startContentBlock(state, event)) {
        yield translated
      }
      break
    }
    case "content_block_delta": {
      for (const translated of translateContentDelta(state, event)) {
        yield translated
      }
      break
    }
    case "content_block_stop": {
      for (const translated of closeContentBlock(state, event.index)) {
        yield translated
      }
      break
    }
    case "message_delta": {
      if (event.delta.stop_reason !== undefined) {
        state.stopReason = event.delta.stop_reason
      }
      if (event.usage) state.usage = mergeUsage(state.usage, event.usage)
      state.copilotUsage = event.copilot_usage ?? state.copilotUsage
      break
    }
    case "message_stop": {
      for (const translated of closeAllBlocks(state)) yield translated
      for (const translated of finishCompaction(state)) yield translated
      state.messageStopped = true
      yield createTerminalEvent(state)
      break
    }
  }
}

function* startContentBlock(
  state: TranslationState,
  event: Extract<AnthropicStreamEventData, { type: "content_block_start" }>,
): Generator<ResponseStreamEvent> {
  const block = event.content_block
  if (state.context.compaction) {
    if (block.type === "text") {
      state.compactionText += block.text
    }
    if (block.type === "tool_use" || block.type === "server_tool_use") {
      state.compactionToolCall = true
    }
    return
  }

  if (block.type === "text") {
    const item: ResponseOutputMessage = {
      id: `msg_${state.responseId.slice(-18)}_${event.index}`,
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [{ type: "output_text", text: block.text, annotations: [] }],
    }
    const output = addOutput(state, item)
    state.blocks.set(event.index, {
      ...output,
      type: "message",
      text: block.text,
      done: false,
    })
    state.outputText += block.text
    yield createEvent(state, {
      type: "response.output_item.added",
      output_index: output.outputIndex,
      item: structuredClone(item),
    })
    yield createEvent(state, {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: output.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    })
    if (block.text) {
      yield createEvent(state, {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: output.outputIndex,
        content_index: 0,
        delta: block.text,
      })
    }
    return
  }

  if (block.type === "thinking") {
    const item: ResponseOutputReasoning = {
      id: markMessagesReasoningId(
        `rs_${state.responseId.slice(-18)}_${event.index}`,
      ),
      type: "reasoning",
      status: "in_progress",
      summary: [],
      encrypted_content: EMPTY_SIGNATURE_ENCRYPTED_CONTENT,
    }
    const output = addOutput(state, item)
    const reasoning: StreamReasoningState = {
      ...output,
      type: "reasoning",
      signature: "",
      summaryStarted: false,
      text: "",
      done: false,
    }
    state.blocks.set(event.index, reasoning)
    yield createEvent(state, {
      type: "response.output_item.added",
      output_index: output.outputIndex,
      item: structuredClone(item),
    })
    if (block.thinking) {
      for (const translated of appendReasoningText(
        state,
        reasoning,
        block.thinking,
      )) {
        yield translated
      }
    }
    return
  }

  if (block.type === "tool_use") {
    const descriptor = resolveToolDescriptor(state.context.registry, block.name)
    const common = {
      id: `fc_${state.responseId.slice(-18)}_${event.index}`,
      call_id: block.id,
      name: descriptor.name,
      status: "in_progress" as const,
      ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}),
    }
    if (descriptor.kind === "custom") {
      const item: ResponseOutputCustomToolCall = {
        ...common,
        type: "custom_tool_call",
        input: "",
      }
      const output = addOutput(state, item)
      const decoder = new CustomToolInputStreamDecoder()
      state.blocks.set(event.index, {
        ...output,
        type: "custom_tool",
        decoder,
        done: false,
      })
      yield createEvent(state, {
        type: "response.output_item.added",
        output_index: output.outputIndex,
        item: structuredClone(item),
      })
      if (Object.keys(block.input).length > 0) {
        const delta = decoder.append(JSON.stringify(block.input))
        if (delta) {
          yield createEvent(state, {
            type: "response.custom_tool_call_input.delta",
            item_id: item.id,
            output_index: output.outputIndex,
            delta,
          })
        }
      }
      return
    }

    const item: ResponseOutputFunctionCall = {
      ...common,
      type: "function_call",
      arguments: "",
    }
    const output = addOutput(state, item)
    const initialInput =
      Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : ""
    state.blocks.set(event.index, {
      ...output,
      type: "function_tool",
      done: false,
    })
    yield createEvent(state, {
      type: "response.output_item.added",
      output_index: output.outputIndex,
      item: structuredClone(item),
    })
    if (initialInput) {
      item.arguments = initialInput
      yield createEvent(state, {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: output.outputIndex,
        delta: initialInput,
      })
    }
  }
}

function* translateContentDelta(
  state: TranslationState,
  event: Extract<AnthropicStreamEventData, { type: "content_block_delta" }>,
): Generator<ResponseStreamEvent> {
  if (state.context.compaction) {
    if (event.delta.type === "text_delta") {
      state.compactionText += event.delta.text
    }
    return
  }

  const block = state.blocks.get(event.index)
  if (!block) return

  if (event.delta.type === "text_delta" && block.type === "message") {
    block.text += event.delta.text
    const part = block.item.content?.[0]
    if (part?.type === "output_text") part.text = block.text
    state.outputText += event.delta.text
    yield createEvent(state, {
      type: "response.output_text.delta",
      item_id: block.item.id,
      output_index: block.outputIndex,
      content_index: 0,
      delta: event.delta.text,
    })
    return
  }

  if (event.delta.type === "thinking_delta" && block.type === "reasoning") {
    for (const translated of appendReasoningText(
      state,
      block,
      event.delta.thinking,
    )) {
      yield translated
    }
    return
  }

  if (event.delta.type === "signature_delta" && block.type === "reasoning") {
    block.signature += event.delta.signature
    block.item.encrypted_content =
      block.signature || EMPTY_SIGNATURE_ENCRYPTED_CONTENT
    return
  }

  if (
    event.delta.type === "input_json_delta"
    && block.type === "function_tool"
  ) {
    block.item.arguments += event.delta.partial_json
    yield createEvent(state, {
      type: "response.function_call_arguments.delta",
      item_id: block.item.id,
      output_index: block.outputIndex,
      delta: event.delta.partial_json,
    })
    return
  }

  if (event.delta.type === "input_json_delta" && block.type === "custom_tool") {
    const delta = block.decoder.append(event.delta.partial_json)
    if (delta) {
      yield createEvent(state, {
        type: "response.custom_tool_call_input.delta",
        item_id: block.item.id,
        output_index: block.outputIndex,
        delta,
      })
    }
  }
}

function* appendReasoningText(
  state: TranslationState,
  block: StreamReasoningState,
  text: string,
): Generator<ResponseStreamEvent> {
  if (!text) return
  if (!block.summaryStarted) {
    block.summaryStarted = true
    yield createEvent(state, {
      type: "response.reasoning_summary_part.added",
      item_id: block.item.id,
      output_index: block.outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    })
  }
  block.text += text
  block.item.summary = [{ type: "summary_text", text: block.text }]
  yield createEvent(state, {
    type: "response.reasoning_summary_text.delta",
    item_id: block.item.id,
    output_index: block.outputIndex,
    summary_index: 0,
    delta: text,
  })
}

function* closeContentBlock(
  state: TranslationState,
  index: number,
): Generator<ResponseStreamEvent> {
  const block = state.blocks.get(index)
  if (!block || block.done) return

  if (block.type === "message") {
    yield createEvent(state, {
      type: "response.output_text.done",
      item_id: block.item.id,
      output_index: block.outputIndex,
      content_index: 0,
      text: block.text,
    })
    const part = block.item.content?.[0]
    if (part) {
      yield createEvent(state, {
        type: "response.content_part.done",
        item_id: block.item.id,
        output_index: block.outputIndex,
        content_index: 0,
        part: structuredClone(part),
      })
    }
  } else if (block.type === "reasoning") {
    if (block.text) {
      const part = { type: "summary_text", text: block.text }
      yield createEvent(state, {
        type: "response.reasoning_summary_text.done",
        item_id: block.item.id,
        output_index: block.outputIndex,
        summary_index: 0,
        text: block.text,
      })
      yield createEvent(state, {
        type: "response.reasoning_summary_part.done",
        item_id: block.item.id,
        output_index: block.outputIndex,
        summary_index: 0,
        part,
      })
    }
    block.item.encrypted_content =
      block.signature || EMPTY_SIGNATURE_ENCRYPTED_CONTENT
  } else if (block.type === "custom_tool") {
    const input = block.decoder.finish()
    block.item.input = input
    yield createEvent(state, {
      type: "response.custom_tool_call_input.done",
      item_id: block.item.id,
      output_index: block.outputIndex,
      name: block.item.name,
      input,
    })
  } else {
    yield createEvent(state, {
      type: "response.function_call_arguments.done",
      item_id: block.item.id,
      output_index: block.outputIndex,
      name: block.item.name,
      arguments: block.item.arguments,
    })
  }

  block.item.status = "completed"
  block.done = true
  yield createEvent(state, {
    type: "response.output_item.done",
    output_index: block.outputIndex,
    item: structuredClone(block.item),
  })
  state.blocks.delete(index)
}

function* closeAllBlocks(
  state: TranslationState,
): Generator<ResponseStreamEvent> {
  for (const index of [...state.blocks.keys()].sort(
    (left, right) => left - right,
  )) {
    for (const translated of closeContentBlock(state, index)) yield translated
  }
}

function* finishCompaction(
  state: TranslationState,
): Generator<ResponseStreamEvent> {
  if (!state.context.compaction) return
  if (state.compactionToolCall) {
    throw new ResponsesMessagesTranslationError(
      "Messages API attempted a tool call during compaction",
      502,
    )
  }
  const summary = state.compactionText.trim()
  if (!summary) {
    throw new ResponsesMessagesTranslationError(
      "Messages API compaction stream did not contain a text summary",
      502,
    )
  }
  const item: ResponseOutputItem = {
    id: `cmp_${state.responseId.slice(-24)}`,
    type: "compaction",
    encrypted_content: encodeMessagesCompaction(summary),
  }
  const output = addOutput(state, item)
  yield createEvent(state, {
    type: "response.output_item.added",
    output_index: output.outputIndex,
    item,
  })
  yield createEvent(state, {
    type: "response.output_item.done",
    output_index: output.outputIndex,
    item,
  })
}

function addOutput<T extends ResponseOutputItem>(
  state: TranslationState,
  item: T,
): StreamOutputState<T> {
  const outputIndex = state.nextOutputIndex
  state.nextOutputIndex += 1
  return { item, outputIndex, done: false }
}

function createLifecycleEvent(
  state: TranslationState,
  type: "response.created" | "response.in_progress",
): ResponseStreamEvent {
  return createEvent(state, {
    type,
    response: createMessagesBackedResponsesResult({
      context: state.context,
      createdAt: state.createdAt,
      id: state.responseId,
      output: [],
      outputText: "",
      status: "in_progress",
      usage: null,
    }),
  })
}

function createTerminalEvent(state: TranslationState): ResponseStreamEvent {
  const finish = resolveFinish(state.stopReason)
  const response = createMessagesBackedResponsesResult({
    context: state.context,
    createdAt: state.createdAt,
    id: state.responseId,
    output: [],
    outputText: state.context.compaction ? "" : state.outputText,
    status: finish.status,
    incompleteReason: finish.incompleteReason,
    usage: translateAnthropicUsage(state.usage),
    copilotUsage: state.copilotUsage,
  })
  return createEvent(state, {
    type:
      finish.status === "incomplete" ?
        "response.incomplete"
      : "response.completed",
    response,
    copilot_usage: state.copilotUsage,
  })
}

function createErrorEvent(
  state: TranslationState,
  error: unknown,
): ResponseStreamEvent {
  const message = error instanceof Error ? error.message : String(error)
  return createEvent(state, {
    type: "error",
    code: "messages_translation_error",
    message,
    param: null,
    error: {
      type: "api_error",
      code: "messages_translation_error",
      message,
    },
  })
}

function createFailedEvent(
  state: TranslationState,
  error: unknown,
): ResponseStreamEvent {
  const message = error instanceof Error ? error.message : String(error)
  return createEvent(state, {
    type: "response.failed",
    response: createMessagesBackedResponsesResult({
      context: state.context,
      createdAt: state.createdAt,
      id: state.responseId,
      output: [],
      outputText: state.outputText,
      status: "failed",
      usage: translateAnthropicUsage(state.usage),
      copilotUsage: state.copilotUsage,
      error: {
        code: "messages_translation_error",
        message,
      },
    }),
    copilot_usage: state.copilotUsage,
  })
}

function createEvent(
  state: TranslationState,
  value: Record<string, unknown>,
): ResponseStreamEvent {
  return {
    ...value,
    sequence_number: state.sequence++,
  } as ResponseStreamEvent
}

function resolveFinish(stopReason: AnthropicResponse["stop_reason"]): {
  status: "completed" | "incomplete"
  incompleteReason?: "content_filter" | "max_output_tokens"
} {
  if (stopReason === "max_tokens") {
    return { status: "incomplete", incompleteReason: "max_output_tokens" }
  }
  if (stopReason === "refusal") {
    return { status: "incomplete", incompleteReason: "content_filter" }
  }
  return { status: "completed" }
}

function mergeUsage(
  current: AnthropicUsage,
  incoming: Partial<AnthropicUsage>,
): AnthropicUsage {
  return {
    ...current,
    ...incoming,
    input_tokens: incoming.input_tokens ?? current.input_tokens,
    output_tokens: incoming.output_tokens ?? current.output_tokens,
  }
}

function parseAnthropicEvent(data: string): AnthropicStreamEventData {
  try {
    const parsed = JSON.parse(data) as unknown
    if (
      typeof parsed === "object"
      && parsed !== null
      && "type" in parsed
      && typeof parsed.type === "string"
    ) {
      return parsed as AnthropicStreamEventData
    }
  } catch {
    // The request error below contains the stable public message.
  }
  throw new ResponsesMessagesTranslationError(
    "Messages API returned malformed streaming JSON",
    502,
  )
}
