import { BRIDGE_TOOL_SEARCH_NAME } from "~/lib/tool-search"
import {
  type ResponseCreatedEvent,
  type ResponsesResult,
} from "~/lib/types/responses"

import { type AnthropicStreamEventData } from "~/lib/types/anthropic"

export interface ResponsesStreamState {
  messageStartSent: boolean
  messageCompleted: boolean
  nextContentBlockIndex: number
  blockIndexByKey: Map<string, number>
  openBlocks: Set<number>
  blockHasDelta: Set<number>
  reasoningSummaryHasDelta: Set<string>
  functionCallStateByOutputIndex: Map<number, FunctionCallStreamState>
  toolSearchName: string
  hasToolCall: boolean
}

export type FunctionCallStreamState = {
  blockIndex: number
  toolCallId: string
  name: string
  consecutiveWhitespaceCount: number
}

export const createResponsesStreamState = (options?: {
  toolSearchName?: string
}): ResponsesStreamState => ({
  messageStartSent: false,
  messageCompleted: false,
  nextContentBlockIndex: 0,
  blockIndexByKey: new Map(),
  openBlocks: new Set(),
  blockHasDelta: new Set(),
  reasoningSummaryHasDelta: new Set(),
  functionCallStateByOutputIndex: new Map(),
  toolSearchName: options?.toolSearchName ?? BRIDGE_TOOL_SEARCH_NAME,
  hasToolCall: false,
})

export const handleResponseCreated = (
  rawEvent: ResponseCreatedEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  return messageStart(state, rawEvent.response)
}

export const messageStart = (
  state: ResponsesStreamState,
  response: ResponsesResult,
): Array<AnthropicStreamEventData> => {
  state.messageStartSent = true
  const inputCachedTokens = response.usage?.input_tokens_details?.cached_tokens
  const cacheWriteTokens =
    response.usage?.input_tokens_details?.cache_write_tokens
  const inputTokens =
    (response.usage?.input_tokens ?? 0)
    - (inputCachedTokens ?? 0)
    - (cacheWriteTokens ?? 0)
  return [
    {
      type: "message_start",
      message: {
        id: response.id,
        type: "message",
        role: "assistant",
        content: [],
        model: response.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
          cache_read_input_tokens: inputCachedTokens ?? 0,
          ...(cacheWriteTokens !== undefined && {
            cache_creation_input_tokens: cacheWriteTokens,
          }),
        },
      },
    },
  ]
}

export const openTextBlockIfNeeded = (
  state: ResponsesStreamState,
  params: {
    outputIndex: number
    contentIndex: number
    events: Array<AnthropicStreamEventData>
  },
): number => {
  const { outputIndex, contentIndex, events } = params
  const key = getBlockKey(outputIndex, contentIndex)
  let blockIndex = state.blockIndexByKey.get(key)

  if (blockIndex === undefined) {
    blockIndex = state.nextContentBlockIndex
    state.nextContentBlockIndex += 1
    state.blockIndexByKey.set(key, blockIndex)
  }

  if (!state.openBlocks.has(blockIndex)) {
    closeOpenBlocks(state, events)
    events.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "text",
        text: "",
      },
    })
    state.openBlocks.add(blockIndex)
  }

  return blockIndex
}

export const openThinkingBlockIfNeeded = (
  state: ResponsesStreamState,
  outputIndex: number,
  events: Array<AnthropicStreamEventData>,
): number => {
  //thinking blocks has multiple summary_index, should combine into one block
  const summaryIndex = 0
  const key = getBlockKey(outputIndex, summaryIndex)
  let blockIndex = state.blockIndexByKey.get(key)

  if (blockIndex === undefined) {
    blockIndex = state.nextContentBlockIndex
    state.nextContentBlockIndex += 1
    state.blockIndexByKey.set(key, blockIndex)
  }

  if (!state.openBlocks.has(blockIndex)) {
    closeOpenBlocks(state, events)
    events.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "thinking",
        thinking: "",
      },
    })
    state.openBlocks.add(blockIndex)
  }

  return blockIndex
}

export const closeBlockIfOpen = (
  state: ResponsesStreamState,
  blockIndex: number,
  events: Array<AnthropicStreamEventData>,
) => {
  if (!state.openBlocks.has(blockIndex)) {
    return
  }

  events.push({ type: "content_block_stop", index: blockIndex })
  state.openBlocks.delete(blockIndex)
  state.blockHasDelta.delete(blockIndex)
}

export const closeOpenBlocks = (
  state: ResponsesStreamState,
  events: Array<AnthropicStreamEventData>,
) => {
  for (const blockIndex of state.openBlocks) {
    closeBlockIfOpen(state, blockIndex, events)
  }
}

export const closeAllOpenBlocks = (
  state: ResponsesStreamState,
  events: Array<AnthropicStreamEventData>,
) => {
  closeOpenBlocks(state, events)

  state.functionCallStateByOutputIndex.clear()
  state.reasoningSummaryHasDelta.clear()
}

export const getBlockKey = (
  outputIndex: number,
  contentIndex: number,
): string => `${outputIndex}:${contentIndex}`
