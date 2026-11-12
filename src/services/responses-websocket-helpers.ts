import {
  decodedResponsesEvent,
  readResponsesStreamEvent,
  type ResponsesStreamChunk,
} from "~/lib/responses-stream-event"
import type {
  ResponseErrorEvent,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import {
  ResponsesWebSocketMessageTooLargeError,
  type PooledWebSocketTerminalDisposition,
} from "~/services/responses-websocket"

export const encodePoolKeyPart = (value: string): string =>
  encodeURIComponent(value)

export const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}

export const createResponsesErrorServerSentEventChunk = (
  message: string,
  code: string | null = null,
): ResponsesStreamChunk => {
  const errorEvent: ResponseErrorEvent = {
    code,
    message,
    param: null,
    sequence_number: 0,
    type: "error",
  }

  return {
    event: errorEvent.type,
    data: JSON.stringify(errorEvent),
    [decodedResponsesEvent]: errorEvent,
  }
}

export const decodeResponsesWebSocketChunk = (
  data: string,
  normalizeEvent: (event: ResponseStreamEvent) => boolean,
): ResponsesStreamChunk => {
  if (!data || data === "[DONE]") return { data }

  let parsed: (ResponseStreamEvent & { id?: unknown }) | null
  try {
    parsed = JSON.parse(data) as typeof parsed
  } catch (error) {
    return error instanceof Error ?
        { data, [decodedResponsesEvent]: error }
      : { data }
  }

  if (parsed === null) return { data, [decodedResponsesEvent]: parsed }
  try {
    return {
      data: normalizeEvent(parsed) ? JSON.stringify(parsed) : data,
      event: typeof parsed.type === "string" ? parsed.type : undefined,
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      [decodedResponsesEvent]: parsed,
    }
  } catch {
    return { data, [decodedResponsesEvent]: parsed }
  }
}

// A failed response (`error` or `response.failed`) can leave the upstream
// connection in a state where the next request sent on it fails as well, so
// the socket is discarded instead of being returned to the pool.
export const getResponsesStreamTerminalDisposition = (
  chunk: ResponsesStreamChunk,
): PooledWebSocketTerminalDisposition => {
  if (!chunk.data || chunk.data === "[DONE]") {
    return "continue"
  }

  try {
    // WebSocket decoders already extracted the event type. Parse only for
    // callers that provide a raw chunk without event metadata.
    const type = chunk.event ?? readResponsesStreamEvent(chunk)?.type

    if (type === "error" || type === "response.failed") {
      return "discard"
    }

    if (type === "response.completed" || type === "response.incomplete") {
      return "reuse"
    }

    return "continue"
  } catch {
    return "continue"
  }
}

export const createResponsesSafeStream = async function* <
  TChunk extends ResponsesStreamChunk,
>(
  source: AsyncIterable<TChunk>,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<TChunk, void, unknown> {
  try {
    yield* source
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) {
      return
    }
    // Stream chunks must allow synthetic errors without extra required fields.
    yield createResponsesErrorServerSentEventChunk(
      getErrorMessage(error),
      error instanceof ResponsesWebSocketMessageTooLargeError ?
        error.code
      : null,
    ) as TChunk
  }
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError"
