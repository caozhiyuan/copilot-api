import {
  type ResponseCompletedEvent,
  type ResponseErrorEvent,
  type ResponseFailedEvent,
  type ResponseIncompleteEvent,
} from "~/lib/types/responses"

import { type AnthropicStreamEventData } from "~/lib/types/anthropic"
import { translateResponsesResultToAnthropic } from "../responses-translation"

import { closeAllOpenBlocks, type ResponsesStreamState } from "./state"

export const handleResponseCompleted = (
  rawEvent: ResponseCompletedEvent | ResponseIncompleteEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const response = rawEvent.response
  const events = new Array<AnthropicStreamEventData>()

  closeAllOpenBlocks(state, events)
  const anthropic = translateResponsesResultToAnthropic(response, {
    hasToolCall: state.hasToolCall,
    toolSearchName: state.toolSearchName,
  })
  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: anthropic.stop_reason,
        stop_sequence: anthropic.stop_sequence,
      },
      usage: anthropic.usage,
    },
    { type: "message_stop" },
  )
  state.messageCompleted = true
  return events
}

export const handleResponseFailed = (
  rawEvent: ResponseFailedEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const response = rawEvent.response
  const events = new Array<AnthropicStreamEventData>()
  closeAllOpenBlocks(state, events)

  const message =
    response.error?.message ?? "The response failed due to an unknown error."

  events.push(buildErrorEvent(message))
  state.messageCompleted = true

  return events
}

export const handleErrorEvent = (
  rawEvent: ResponseErrorEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const message =
    typeof rawEvent.message === "string" ?
      rawEvent.message
    : "An unexpected error occurred during streaming."

  state.messageCompleted = true
  return [buildErrorEvent(message)]
}

export const buildErrorEvent = (message: string): AnthropicStreamEventData => ({
  type: "error",
  error: {
    type: "api_error",
    message,
  },
})
