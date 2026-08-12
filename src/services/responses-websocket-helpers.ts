import type { ResponseErrorEvent } from "~/lib/types/responses"

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

export const isTerminalResponsesStreamChunk = (chunk: {
  data?: string
}): boolean => {
  if (!chunk.data || chunk.data === "[DONE]") {
    return false
  }

  try {
    const parsed = JSON.parse(chunk.data) as { type?: unknown }
    return (
      parsed.type === "response.completed"
      || parsed.type === "response.failed"
      || parsed.type === "response.incomplete"
      || parsed.type === "error"
    )
  } catch {
    return false
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
