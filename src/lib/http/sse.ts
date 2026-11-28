import type { SSEMessage, SSEStreamingApi } from "hono/streaming"

import { requestContext } from "./request-context"

const isProtocolFailure = (eventType: string | undefined): boolean =>
  eventType === "error" || eventType === "response.failed"

export async function writeSSEIfConnected(
  stream: SSEStreamingApi,
  message: SSEMessage,
  eventType = message.event,
): Promise<boolean> {
  if (stream.aborted) return false

  // Failure can be signalled by either the SSE event line or the JSON type.
  if (isProtocolFailure(eventType) || isProtocolFailure(message.event)) {
    const timing = requestContext.getStore()?.requestTiming
    if (timing) timing.protocolFailed = true
  }

  try {
    await stream.writeSSE(message)
    return true
  } catch (error) {
    if (stream.aborted) return false
    throw error
  }
}

export async function writeRawSSEIfConnected(
  stream: SSEStreamingApi,
  chunk: string,
): Promise<boolean> {
  if (stream.aborted || stream.closed) return false

  try {
    await stream.write(chunk)
    return !stream.aborted && !stream.closed
  } catch (error) {
    if (stream.aborted || stream.closed) return false
    throw error
  }
}

export async function forEachWithIdleKeepalive<T>(
  source: AsyncIterable<T>,
  options: {
    intervalMs: number
    signal: AbortSignal
    onChunk: (chunk: T) => Promise<boolean>
    onKeepalive: () => Promise<boolean>
  },
): Promise<void> {
  const { intervalMs, signal, onChunk, onKeepalive } = options
  const iterator = source[Symbol.asyncIterator]()
  let pendingNext: Promise<IteratorResult<T>> | undefined
  let finished = false

  const waitForStep = async (
    nextPromise: Promise<IteratorResult<T>>,
  ): Promise<
    | { kind: "next"; result: IteratorResult<T> }
    | { kind: "idle" }
    | { kind: "aborted" }
  > => {
    if (signal.aborted) return { kind: "aborted" }

    return await new Promise((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        signal.removeEventListener("abort", onAbort)
      }

      const settle = (action: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        action()
      }

      const onAbort = () => settle(() => resolve({ kind: "aborted" }))

      if (Number.isFinite(intervalMs) && intervalMs > 0) {
        timer = setTimeout(
          () => settle(() => resolve({ kind: "idle" })),
          intervalMs,
        )
      }

      signal.addEventListener("abort", onAbort, { once: true })
      nextPromise.then(
        (result) => settle(() => resolve({ kind: "next", result })),
        (error: unknown) =>
          settle(() =>
            reject(error instanceof Error ? error : new Error(String(error))),
          ),
      )
    })
  }

  try {
    while (!signal.aborted) {
      pendingNext ??= iterator.next()
      const step = await waitForStep(pendingNext)
      if (step.kind === "aborted") {
        break
      }
      if (step.kind === "idle") {
        const connected = await onKeepalive()
        if (!connected) break
        continue
      }

      pendingNext = undefined
      if (step.result.done) {
        finished = true
        break
      }

      const connected = await onChunk(step.result.value)
      if (!connected) break
    }
  } finally {
    if (pendingNext) {
      void pendingNext.catch(() => {})
    }
    if (!finished) {
      void iterator.return?.().catch(() => {})
    }
  }
}
