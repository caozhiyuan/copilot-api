import type { ResponseErrorEvent } from "~/lib/types/responses"
import type { PooledWebSocketTerminalDisposition } from "~/services/responses-websocket"

export interface ResponsesStreamErrorChunk {
  data?: string
  event?: string
}

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
): ResponsesStreamErrorChunk => {
  const errorEvent: ResponseErrorEvent = {
    code: null,
    message,
    param: null,
    sequence_number: 0,
    type: "error",
  }

  return {
    event: errorEvent.type,
    data: JSON.stringify(errorEvent),
  }
}

// A failed response (`error` or `response.failed`) can leave the upstream
// connection in a state where the next request sent on it fails as well, so
// the socket is discarded instead of being returned to the pool.
export const getResponsesStreamTerminalDisposition = (chunk: {
  data?: string
}): PooledWebSocketTerminalDisposition => {
  if (!chunk.data || chunk.data === "[DONE]") {
    return "continue"
  }

  try {
    const parsed = JSON.parse(chunk.data) as { type?: unknown }
    if (parsed.type === "error" || parsed.type === "response.failed") {
      return "discard"
    }

    if (
      parsed.type === "response.completed"
      || parsed.type === "response.incomplete"
    ) {
      return "reuse"
    }

    return "continue"
  } catch {
    return "continue"
  }
}

export const createResponsesSafeStream = async function* <
  TChunk extends ResponsesStreamErrorChunk,
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
    // The cast relies on TChunk staying shape-compatible with the error chunk
    // ({ data, event } only, no required extra fields). Keep new call sites
    // within that constraint.
    yield createResponsesErrorServerSentEventChunk(
      getErrorMessage(error),
    ) as TChunk
  }
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError"
