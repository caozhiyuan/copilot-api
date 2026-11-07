import type { AnthropicStreamEventData } from "~/lib/types/anthropic"
import type { ResponseStreamEvent } from "~/lib/types/responses"

import {
  handleReasoningSummaryPartAdded,
  handleReasoningSummaryTextDelta,
  handleReasoningSummaryTextDone,
} from "./reasoning"
import { handleResponseCreated, type ResponsesStreamState } from "./state"
import {
  handleErrorEvent,
  handleResponseCompleted,
  handleResponseFailed,
} from "./terminal"
import { handleOutputTextDelta } from "./text"
import {
  handleFunctionCallArgumentsDelta,
  handleFunctionCallArgumentsDone,
  handleOutputItemAdded,
  handleOutputItemDone,
} from "./tools"

export type { ResponsesStreamState } from "./state"
export { createResponsesStreamState } from "./state"
export { buildErrorEvent } from "./terminal"

export const translateResponsesStreamEvent = (
  rawEvent: ResponseStreamEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const eventType = rawEvent.type
  switch (eventType) {
    case "response.created": {
      return handleResponseCreated(rawEvent, state)
    }

    case "response.output_item.added": {
      return handleOutputItemAdded(rawEvent, state)
    }

    case "response.reasoning_summary_text.delta": {
      return handleReasoningSummaryTextDelta(rawEvent, state)
    }

    case "response.reasoning_summary_part.added": {
      return handleReasoningSummaryPartAdded(rawEvent, state)
    }

    case "response.output_text.delta": {
      return handleOutputTextDelta(rawEvent, state)
    }

    case "response.reasoning_summary_text.done": {
      return handleReasoningSummaryTextDone(rawEvent, state)
    }

    case "response.output_item.done": {
      return handleOutputItemDone(rawEvent, state)
    }

    case "response.function_call_arguments.delta": {
      return handleFunctionCallArgumentsDelta(rawEvent, state)
    }

    case "response.function_call_arguments.done": {
      return handleFunctionCallArgumentsDone(rawEvent, state)
    }

    case "response.completed":
    case "response.incomplete": {
      return handleResponseCompleted(rawEvent, state)
    }

    case "response.failed": {
      return handleResponseFailed(rawEvent, state)
    }

    case "error": {
      return handleErrorEvent(rawEvent, state)
    }

    default: {
      return []
    }
  }
}
