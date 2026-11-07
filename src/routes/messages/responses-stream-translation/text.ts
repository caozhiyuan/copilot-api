import { type ResponseTextDeltaEvent } from "~/lib/types/responses"

import { type AnthropicStreamEventData } from "~/lib/types/anthropic"

import { openTextBlockIfNeeded, type ResponsesStreamState } from "./state"

export const handleOutputTextDelta = (
  rawEvent: ResponseTextDeltaEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const events = new Array<AnthropicStreamEventData>()
  const outputIndex = rawEvent.output_index
  const contentIndex = rawEvent.content_index
  const deltaText = rawEvent.delta

  if (!deltaText) {
    return events
  }

  const blockIndex = openTextBlockIfNeeded(state, {
    outputIndex,
    contentIndex,
    events,
  })

  events.push({
    type: "content_block_delta",
    index: blockIndex,
    delta: {
      type: "text_delta",
      text: deltaText,
    },
  })
  state.blockHasDelta.add(blockIndex)

  return events
}
