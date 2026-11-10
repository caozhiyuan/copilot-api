import { randomUUID } from "node:crypto"

import type {
  ResponseFailedEvent,
  ResponseStreamEvent,
} from "~/lib/types/responses"

const FAILURE_CODE = "server_error"
const STREAM_ENDED_MESSAGE =
  "The upstream Responses stream ended before sending a terminal event."

export interface ResponsesStreamFailure {
  code: string
  message: string
  sse: { data: string; event: string }
}

// Codex ignores a bare `error` event and only classifies failures reported by
// `response.failed`. Without a terminal event it reports the unhelpful "stream
// closed before response.completed" and retries the identical request.
export const createResponsesStreamTerminalTracker = (model: string) => {
  let terminal = false
  let upstreamError: { code: string; message: string } | undefined
  let sequenceNumber = 0

  return {
    observe: (event: ResponseStreamEvent | null): void => {
      if (!event) return

      if (Number.isFinite(event.sequence_number)) {
        sequenceNumber = Math.max(sequenceNumber, event.sequence_number)
      }
      if (
        event.type === "response.completed"
        || event.type === "response.incomplete"
        || event.type === "response.failed"
      ) {
        terminal = true
      } else if (event.type === "error") {
        upstreamError = {
          code: event.error?.code ?? event.code ?? FAILURE_CODE,
          message: event.error?.message ?? event.message,
        }
      }
    },

    // Returns the `response.failed` event that closes an unterminated stream,
    // or null when the upstream already sent its own terminal event.
    finalize: (responseId?: string): ResponsesStreamFailure | null => {
      if (terminal) return null
      terminal = true

      const failure = upstreamError ?? {
        code: FAILURE_CODE,
        message: STREAM_ENDED_MESSAGE,
      }
      const event = createFailedEvent(
        model,
        failure,
        sequenceNumber + 1,
        responseId ?? `resp_${randomUUID().replaceAll("-", "")}`,
      )

      return {
        ...failure,
        sse: { data: JSON.stringify(event), event: event.type },
      }
    },
  }
}

const createFailedEvent = (
  model: string,
  { code, message }: { code: string; message: string },
  sequenceNumber: number,
  responseId: string,
): ResponseFailedEvent => ({
  response: {
    created_at: Math.floor(Date.now() / 1000),
    error: { code, message },
    id: responseId,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model,
    object: "response",
    output: [],
    output_text: "",
    parallel_tool_calls: false,
    status: "failed",
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    usage: null,
  },
  sequence_number: sequenceNumber,
  type: "response.failed",
})
