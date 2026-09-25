// Copilot sometimes fails a Responses request right after announcing it, for
// example with "Encrypted function output content could not be decrypted or
// decoded" when the connection lands on a backend that cannot decrypt the
// encrypted items being replayed. Nothing has been generated at that point, so
// the request can be sent again on a new connection. The announcement events
// are held back until the first output event so the client never sees the
// failed attempt.

export interface ResponsesStreamChunk {
  data?: string
  event?: string
}

// Events that only announce a response; the model has produced nothing yet.
const PRE_OUTPUT_EVENT_TYPES = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
])

const RETRYABLE_ERROR_MESSAGES = [
  "encrypted function output content could not be decrypted",
  "internal server error",
]

export const createEarlyFailureRetryStream = async function* <
  TChunk extends ResponsesStreamChunk,
>(
  initialStream: AsyncIterable<TChunk>,
  options: {
    maxRetries: number
    retry: () => Promise<AsyncIterable<TChunk>>
    onRetry?: (attempt: number, reason: string) => void
  },
): AsyncGenerator<TChunk, void, unknown> {
  let stream = initialStream

  for (let attempt = 0; ; attempt += 1) {
    const heldBack: Array<TChunk> = []
    let outputStarted = false
    let failure: { chunk: TChunk; reason: string } | undefined

    for await (const chunk of stream) {
      if (outputStarted) {
        yield chunk
        continue
      }

      const event = parseStreamEvent(chunk)
      const eventType = getString(event?.type) ?? chunk.event
      if (eventType && PRE_OUTPUT_EVENT_TYPES.has(eventType)) {
        heldBack.push(chunk)
        continue
      }

      const reason =
        attempt < options.maxRetries ? getRetryReason(event) : undefined
      if (reason) {
        failure = { chunk, reason }
        break
      }

      outputStarted = true
      yield* heldBack.splice(0)
      yield chunk
    }

    if (!failure) {
      yield* heldBack
      return
    }

    options.onRetry?.(attempt + 1, failure.reason)
    try {
      stream = await options.retry()
    } catch {
      // Starting the retry failed; surface the original failure instead.
      yield* heldBack
      yield failure.chunk
      return
    }
  }
}

const getRetryReason = (
  event: Record<string, unknown> | undefined,
): string | undefined => {
  if (event?.type === "response.failed") {
    const response = isRecord(event.response) ? event.response : undefined
    const error = isRecord(response?.error) ? response.error : undefined
    if (!error) return "response.failed without error details"
    return getRetryableMessage(error.message)
  }

  if (event?.type === "error") {
    const error = isRecord(event.error) ? event.error : undefined
    return getRetryableMessage(error?.message ?? event.message)
  }

  return undefined
}

const getRetryableMessage = (message: unknown): string | undefined => {
  if (typeof message !== "string") return undefined
  const normalized = message.toLowerCase()
  return (
      RETRYABLE_ERROR_MESSAGES.some((pattern) => normalized.includes(pattern))
    ) ?
      message
    : undefined
}

const parseStreamEvent = (
  chunk: ResponsesStreamChunk,
): Record<string, unknown> | undefined => {
  if (!chunk.data || chunk.data === "[DONE]") return undefined
  try {
    const parsed: unknown = JSON.parse(chunk.data)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const getString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value))
