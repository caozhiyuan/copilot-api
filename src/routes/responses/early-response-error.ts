interface StreamChunk {
  data?: string
  event?: string
}

interface InvalidRequestError {
  code: string
  message: string
  param: unknown
  type: "invalid_request_error"
}

interface PreflightOptions {
  signal?: AbortSignal
  timeoutMs?: number
  errorDetailTimeoutMs?: number
  maxBufferedBytes?: number
  maxBufferedEvents?: number
}

const ANNOUNCEMENTS = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
])
const TIMED_OUT = Symbol("stream preflight timed out")

// Copilot can send response.failed(error:null) followed by the useful error.
// Read a bounded prefix before committing HTTP 200, so invalid requests can
// retain their HTTP 400 classification through another gateway. This never
// retries a request, and stops at the first event carrying model output.
export async function preflightResponseStream<T extends StreamChunk>(
  source: AsyncIterable<T>,
  options: PreflightOptions = {},
): Promise<{
  stream: AsyncIterable<T>
  buffered: Array<T>
  error?: InvalidRequestError
  close: () => Promise<void>
}> {
  const iterator = source[Symbol.asyncIterator]()
  const buffered: Array<T> = []
  const deadline = Date.now() + (options.timeoutMs ?? 2_000)
  const maxBytes = options.maxBufferedBytes ?? 256 * 1024
  const maxEvents = options.maxBufferedEvents ?? 16
  let bytes = 0
  let pending: Promise<IteratorResult<T>> | undefined
  let ended = false
  let closed = false
  let error: InvalidRequestError | undefined

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await iterator.return?.()
  }

  const next = async (): Promise<IteratorResult<T>> => {
    const item = await (pending ??= Promise.resolve().then(() =>
      iterator.next(),
    ))
    pending = undefined
    if (item.done) ended = true
    return item
  }

  const readBefore = async (
    readDeadline: number,
  ): Promise<IteratorResult<T> | typeof TIMED_OUT> => {
    options.signal?.throwIfAborted()
    const remaining = readDeadline - Date.now()
    if (remaining <= 0) return TIMED_OUT
    // Keep an in-flight read after a timeout; the returned stream must consume
    // that same result rather than starting a second read or losing a chunk.
    pending ??= Promise.resolve().then(() => iterator.next())
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectAbort: (() => void) | undefined
    try {
      const result = await Promise.race([
        pending,
        new Promise<typeof TIMED_OUT>((resolve, reject) => {
          timer = setTimeout(() => resolve(TIMED_OUT), remaining)
          rejectAbort = () => {
            const reason: unknown = options.signal?.reason
            reject(
              reason instanceof Error ? reason : (
                new Error("Responses request aborted", { cause: reason })
              ),
            )
          }
          options.signal?.addEventListener("abort", rejectAbort, { once: true })
        }),
      ])
      if (result !== TIMED_OUT) {
        pending = undefined
        if (result.done) ended = true
      }
      return result
    } finally {
      clearTimeout(timer)
      if (rejectAbort) options.signal?.removeEventListener("abort", rejectAbort)
    }
  }

  const hold = (chunk: T): Record<string, unknown> | undefined => {
    buffered.push(chunk)
    bytes +=
      Buffer.byteLength(chunk.data ?? "") + Buffer.byteLength(chunk.event ?? "")
    return parseEvent(chunk)
  }

  try {
    while (buffered.length < maxEvents && bytes < maxBytes) {
      const item = await readBefore(deadline)
      if (item === TIMED_OUT || item.done) break
      const event = hold(item.value)
      if (hasOutput(event)) break
      const type = event?.type ?? item.value.event
      if (typeof type === "string" && ANNOUNCEMENTS.has(type)) continue

      error = getInvalidRequestError(event)
      if (error) break

      if (
        type === "response.failed"
        && !hasErrorDetails(event)
        && buffered.length < maxEvents
        && bytes < maxBytes
      ) {
        const detail = await readBefore(
          Math.min(
            deadline,
            Date.now() + (options.errorDetailTimeoutMs ?? 250),
          ),
        )
        if (detail !== TIMED_OUT && !detail.done) {
          const detailEvent = hold(detail.value)
          if (!hasOutput(detailEvent))
            error = getInvalidRequestError(detailEvent)
        }
      }
      break
    }
  } catch (cause) {
    // The caller owns upstream cancellation. Do not wait for a pending read
    // here: an aborted HTTP/WebSocket transport will settle it during cleanup.
    void close().catch(() => {})
    throw cause
  }

  const stream = async function* (): AsyncGenerator<T, void, unknown> {
    try {
      yield* buffered
      while (!ended && !closed) {
        const item = await next()
        if (item.done) return
        yield item.value
      }
    } finally {
      await close()
    }
  }

  return { stream: stream(), buffered, error, close }
}

function parseEvent(chunk: StreamChunk): Record<string, unknown> | undefined {
  if (!chunk.data || chunk.data === "[DONE]") return undefined
  try {
    const event: unknown = JSON.parse(chunk.data)
    return isRecord(event) ? event : undefined
  } catch {
    return undefined
  }
}

function hasOutput(event: Record<string, unknown> | undefined): boolean {
  return (
    isRecord(event?.response)
    && Array.isArray(event.response.output)
    && event.response.output.length > 0
  )
}

function hasErrorDetails(event: Record<string, unknown> | undefined): boolean {
  if (!isRecord(event?.response) || !isRecord(event.response.error))
    return false
  const error = event.response.error
  return Boolean(error.code || error.message)
}

function getInvalidRequestError(
  event: Record<string, unknown> | undefined,
): InvalidRequestError | undefined {
  let error: Record<string, unknown> | undefined
  if (event?.type === "error")
    error = isRecord(event.error) ? event.error : event
  if (event?.type === "response.failed" && isRecord(event.response)) {
    error = isRecord(event.response.error) ? event.response.error : undefined
  }
  if (
    (error?.code !== "invalid_request_body"
      && error?.code !== "invalid_request_error")
    || typeof error.message !== "string"
    || !error.message
  )
    return undefined
  return {
    code: error.code,
    message: error.message,
    param: error.param ?? null,
    type: "invalid_request_error",
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
