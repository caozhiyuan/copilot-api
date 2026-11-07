import {
  type ResponseReasoningSummaryPartAddedEvent,
  type ResponseReasoningSummaryTextDeltaEvent,
  type ResponseReasoningSummaryTextDoneEvent,
} from "~/lib/types/responses"

import { type AnthropicStreamEventData } from "~/lib/types/anthropic"
import { REASONING_SUMMARY_SEPARATOR } from "../responses-translation"

import {
  getBlockKey,
  openThinkingBlockIfNeeded,
  type ResponsesStreamState,
} from "./state"

export const handleReasoningSummaryTextDelta = (
  rawEvent: ResponseReasoningSummaryTextDeltaEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const outputIndex = rawEvent.output_index
  const summaryIndex = rawEvent.summary_index
  const deltaText = rawEvent.delta
  const events = new Array<AnthropicStreamEventData>()

  if (!deltaText) {
    return events
  }

  const blockIndex = openThinkingBlockIfNeeded(state, outputIndex, events)

  events.push({
    type: "content_block_delta",
    index: blockIndex,
    delta: {
      type: "thinking_delta",
      thinking: deltaText,
    },
  })
  state.blockHasDelta.add(blockIndex)
  state.reasoningSummaryHasDelta.add(getBlockKey(outputIndex, summaryIndex))

  return events
}

export const handleReasoningSummaryPartAdded = (
  rawEvent: ResponseReasoningSummaryPartAddedEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const events = new Array<AnthropicStreamEventData>()
  const blockIndex = openThinkingBlockIfNeeded(
    state,
    rawEvent.output_index,
    events,
  )

  if (rawEvent.summary_index === 0) {
    return events
  }

  events.push({
    type: "content_block_delta",
    index: blockIndex,
    delta: {
      type: "thinking_delta",
      thinking: REASONING_SUMMARY_SEPARATOR,
    },
  })
  state.blockHasDelta.add(blockIndex)
  return events
}

export const handleReasoningSummaryTextDone = (
  rawEvent: ResponseReasoningSummaryTextDoneEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const outputIndex = rawEvent.output_index
  const summaryIndex = rawEvent.summary_index
  const text = rawEvent.text
  const events = new Array<AnthropicStreamEventData>()
  const blockIndex = openThinkingBlockIfNeeded(state, outputIndex, events)
  const summaryKey = getBlockKey(outputIndex, summaryIndex)

  if (text && !state.reasoningSummaryHasDelta.has(summaryKey)) {
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "thinking_delta",
        thinking: text,
      },
    })
    state.blockHasDelta.add(blockIndex)
  }

  return events
}
