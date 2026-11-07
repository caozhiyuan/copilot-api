import { formatToolSearchBridgeArguments } from "~/lib/tool-search"
import {
  type ResponseFunctionCallArgumentsDeltaEvent,
  type ResponseFunctionCallArgumentsDoneEvent,
  type ResponseOutputItemAddedEvent,
  type ResponseOutputItemDoneEvent,
} from "~/lib/types/responses"

import { type AnthropicStreamEventData } from "~/lib/types/anthropic"
import {
  encodeCompactionCarrierSignature,
  resolveToolUseName,
} from "../responses-translation"

import { buildErrorEvent } from "./terminal"
import {
  closeAllOpenBlocks,
  closeOpenBlocks,
  openThinkingBlockIfNeeded,
  type ResponsesStreamState,
} from "./state"

export const MAX_CONSECUTIVE_FUNCTION_CALL_WHITESPACE = 20

export class FunctionCallArgumentsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FunctionCallArgumentsValidationError"
  }
}

export const updateWhitespaceRunState = (
  previousCount: number,
  chunk: string,
): {
  nextCount: number
  exceeded: boolean
} => {
  let count = previousCount

  for (const char of chunk) {
    if (char === "\r" || char === "\n" || char === "\t") {
      count += 1
      if (count > MAX_CONSECUTIVE_FUNCTION_CALL_WHITESPACE) {
        return { nextCount: count, exceeded: true }
      }
      continue
    }

    if (char !== " ") {
      count = 0
    }
  }

  return { nextCount: count, exceeded: false }
}

export const handleOutputItemAdded = (
  rawEvent: ResponseOutputItemAddedEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const events = new Array<AnthropicStreamEventData>()
  const functionCallDetails = extractFunctionCallDetails(rawEvent, state)
  if (!functionCallDetails) {
    return events
  }

  const { outputIndex, toolCallId, name, initialArguments } =
    functionCallDetails
  const blockIndex = openFunctionCallBlock(state, {
    outputIndex,
    toolCallId,
    name,
    events,
  })

  if (initialArguments !== undefined && initialArguments.length > 0) {
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "input_json_delta",
        partial_json: initialArguments,
      },
    })
    state.blockHasDelta.add(blockIndex)
  }

  return events
}

export const handleOutputItemDone = (
  rawEvent: ResponseOutputItemDoneEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const events = new Array<AnthropicStreamEventData>()
  const item = rawEvent.item
  const itemType = item.type
  const outputIndex = rawEvent.output_index

  if (itemType === "tool_search_call") {
    const blockIndex = openFunctionCallBlock(state, {
      outputIndex,
      toolCallId: item.call_id,
      name: state.toolSearchName,
      events,
    })
    const finalArguments = stringifyToolSearchArguments(item.arguments)

    if (!state.blockHasDelta.has(blockIndex) && finalArguments) {
      events.push({
        type: "content_block_delta",
        index: blockIndex,
        delta: {
          type: "input_json_delta",
          partial_json: finalArguments,
        },
      })
      state.blockHasDelta.add(blockIndex)
    }

    state.functionCallStateByOutputIndex.delete(outputIndex)
    return events
  }

  if (itemType === "compaction") {
    if (!item.id || !item.encrypted_content) {
      return events
    }

    const blockIndex = openThinkingBlockIfNeeded(state, outputIndex, events)

    if (!state.blockHasDelta.has(blockIndex)) {
      events.push({
        type: "content_block_delta",
        index: blockIndex,
        delta: {
          type: "thinking_delta",
          thinking: "",
        },
      })
    }

    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "signature_delta",
        signature: encodeCompactionCarrierSignature({
          id: item.id,
          encrypted_content: item.encrypted_content,
        }),
      },
    })
    state.blockHasDelta.add(blockIndex)
    return events
  }

  if (itemType !== "reasoning") {
    return events
  }

  const blockIndex = openThinkingBlockIfNeeded(state, outputIndex, events)
  const signature = (item.encrypted_content ?? "") + "@" + item.id
  if (signature) {
    if (
      (!item.summary || item.summary.length === 0)
      && !state.blockHasDelta.has(blockIndex)
    ) {
      events.push({
        type: "content_block_delta",
        index: blockIndex,
        delta: {
          type: "thinking_delta",
          thinking: "",
        },
      })
    }

    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "signature_delta",
        signature,
      },
    })
    state.blockHasDelta.add(blockIndex)
  }

  return events
}

export const handleFunctionCallArgumentsDelta = (
  rawEvent: ResponseFunctionCallArgumentsDeltaEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const events = new Array<AnthropicStreamEventData>()
  const outputIndex = rawEvent.output_index
  const deltaText = rawEvent.delta

  if (!deltaText) {
    return events
  }

  const blockIndex = openFunctionCallBlock(state, {
    outputIndex,
    events,
  })

  const functionCallState =
    state.functionCallStateByOutputIndex.get(outputIndex)
  if (!functionCallState) {
    return handleFunctionCallArgumentsValidationError(
      new FunctionCallArgumentsValidationError(
        "Received function call arguments delta without an open tool call block.",
      ),
      state,
      events,
    )
  }

  // Copilot can stream tool-call arguments as whitespace until max_tokens; more than 20 in a row is treated as a corrupted argument stream.
  const { nextCount, exceeded } = updateWhitespaceRunState(
    functionCallState.consecutiveWhitespaceCount,
    deltaText,
  )
  if (exceeded) {
    return handleFunctionCallArgumentsValidationError(
      new FunctionCallArgumentsValidationError(
        "Received function call arguments delta containing more than 20 consecutive whitespace characters.",
      ),
      state,
      events,
    )
  }
  functionCallState.consecutiveWhitespaceCount = nextCount

  events.push({
    type: "content_block_delta",
    index: blockIndex,
    delta: {
      type: "input_json_delta",
      partial_json: deltaText,
    },
  })
  state.blockHasDelta.add(blockIndex)

  return events
}

export const handleFunctionCallArgumentsDone = (
  rawEvent: ResponseFunctionCallArgumentsDoneEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const events = new Array<AnthropicStreamEventData>()
  const outputIndex = rawEvent.output_index
  const blockIndex = openFunctionCallBlock(state, {
    outputIndex,
    events,
  })

  const finalArguments =
    typeof rawEvent.arguments === "string" ? rawEvent.arguments : undefined

  if (!state.blockHasDelta.has(blockIndex) && finalArguments) {
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "input_json_delta",
        partial_json: finalArguments,
      },
    })
    state.blockHasDelta.add(blockIndex)
  }

  state.functionCallStateByOutputIndex.delete(outputIndex)
  return events
}

export const handleFunctionCallArgumentsValidationError = (
  error: FunctionCallArgumentsValidationError,
  state: ResponsesStreamState,
  events: Array<AnthropicStreamEventData> = [],
): Array<AnthropicStreamEventData> => {
  const reason = error.message

  closeAllOpenBlocks(state, events)
  state.messageCompleted = true

  events.push(buildErrorEvent(reason))

  return events
}

export const openFunctionCallBlock = (
  state: ResponsesStreamState,
  params: {
    outputIndex: number
    toolCallId?: string
    name?: string
    events: Array<AnthropicStreamEventData>
  },
): number => {
  const { outputIndex, toolCallId, name, events } = params

  state.hasToolCall = true

  let functionCallState = state.functionCallStateByOutputIndex.get(outputIndex)

  if (!functionCallState) {
    const blockIndex = state.nextContentBlockIndex
    state.nextContentBlockIndex += 1

    const resolvedToolCallId = toolCallId ?? `tool_call_${blockIndex}`
    const resolvedName = name ?? "function"

    functionCallState = {
      blockIndex,
      toolCallId: resolvedToolCallId,
      name: resolvedName,
      consecutiveWhitespaceCount: 0,
    }

    state.functionCallStateByOutputIndex.set(outputIndex, functionCallState)
  }

  const { blockIndex } = functionCallState

  if (!state.openBlocks.has(blockIndex)) {
    closeOpenBlocks(state, events)
    events.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: functionCallState.toolCallId,
        name: functionCallState.name,
        input: {},
      },
    })
    state.openBlocks.add(blockIndex)
  }

  return blockIndex
}

export type FunctionCallDetails = {
  outputIndex: number
  toolCallId: string
  name: string
  initialArguments?: string
}

export const extractFunctionCallDetails = (
  rawEvent: ResponseOutputItemAddedEvent,
  state: ResponsesStreamState,
): FunctionCallDetails | undefined => {
  const item = rawEvent.item
  const itemType = item.type
  if (itemType === "tool_search_call") {
    const outputIndex = rawEvent.output_index
    const toolCallId = item.call_id
    const name = state.toolSearchName
    return {
      outputIndex,
      toolCallId,
      name,
      initialArguments: "",
    }
  }

  if (itemType !== "function_call") {
    return undefined
  }

  const outputIndex = rawEvent.output_index
  const toolCallId = item.call_id
  const name = resolveToolUseName(item)
  const initialArguments = item.arguments
  return {
    outputIndex,
    toolCallId,
    name,
    initialArguments,
  }
}

export const stringifyToolSearchArguments = (
  argumentsValue: Record<string, unknown> | string,
): string | undefined => {
  try {
    return JSON.stringify(formatToolSearchBridgeArguments(argumentsValue))
  } catch {
    return undefined
  }
}
