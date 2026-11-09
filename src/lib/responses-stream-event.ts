import type { ServerSentEventMessage } from "fetch-event-stream"

import type { ResponseStreamEvent } from "~/lib/types/responses"

// Keep the decoded object out of SSE messages and JSON debug logs.
export const decodedResponsesEvent = Symbol("decodedResponsesEvent")

export interface ResponsesStreamChunk extends ServerSentEventMessage {
  readonly [decodedResponsesEvent]?: ResponseStreamEvent | Error | null
}

export const readResponsesStreamEvent = (
  chunk: ResponsesStreamChunk,
): ResponseStreamEvent | null => {
  const decoded = chunk[decodedResponsesEvent]
  if (decoded instanceof Error) throw decoded
  if (decoded !== undefined) return decoded

  const { data } = chunk
  if (!data || data === "[DONE]") return null
  return JSON.parse(data) as ResponseStreamEvent
}
