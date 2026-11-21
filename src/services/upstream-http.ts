import {
  UpstreamHeadersTimeoutError,
  UpstreamStreamInactivityTimeoutError,
} from "~/lib/http/error"

export interface UpstreamHttpLifecycleOptions {
  clientSignal?: AbortSignal
  headersTimeoutMs: number
  streamInactivityTimeoutMs: number
}

export async function fetchUpstreamWithLifecycle(
  input: string | URL | Request,
  init: RequestInit,
  options: UpstreamHttpLifecycleOptions,
): Promise<Response> {
  options.clientSignal?.throwIfAborted()
  init.signal?.throwIfAborted()
  const lifecycle = createRequestLifecycle(options)
  const signal =
    init.signal ?
      AbortSignal.any([init.signal, lifecycle.signal])
    : lifecycle.signal

  try {
    const response = await fetch(input, {
      ...init,
      signal,
    })
    lifecycle.headersReceived()
    return createManagedResponse(response, lifecycle, options)
  } catch (error) {
    throw lifecycle.finishWithError(error)
  }
}

interface RequestLifecycle {
  abort: (reason: Error) => void
  finish: () => void
  finishWithError: (error: unknown) => Error
  headersReceived: () => void
  signal: AbortSignal
}

const createRequestLifecycle = (
  options: UpstreamHttpLifecycleOptions,
): RequestLifecycle => {
  const controller = new AbortController()
  let finished = false
  let headersTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort(new UpstreamHeadersTimeoutError(options.headersTimeoutMs))
  }, options.headersTimeoutMs)

  const clearHeadersTimer = () => {
    if (headersTimer === null) return
    clearTimeout(headersTimer)
    headersTimer = null
  }

  const finish = () => {
    if (finished) return
    finished = true
    clearHeadersTimer()
  }

  return {
    abort: (reason) => {
      if (!controller.signal.aborted) controller.abort(reason)
    },
    finish,
    finishWithError: (error) => {
      const reason = controller.signal.reason as unknown
      finish()
      return reason instanceof Error ? reason : toError(error)
    },
    headersReceived: clearHeadersTimer,
    signal: controller.signal,
  }
}

const createManagedResponse = (
  response: Response,
  lifecycle: RequestLifecycle,
  options: UpstreamHttpLifecycleOptions,
): Response => {
  if (!response.body) {
    lifecycle.finish()
    return response
  }

  const body = createManagedResponseBody(response.body, lifecycle, options)
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
}

const createManagedResponseBody = (
  body: ReadableStream<Uint8Array>,
  lifecycle: RequestLifecycle,
  options: UpstreamHttpLifecycleOptions,
): ReadableStream<Uint8Array> => {
  const reader = body.getReader()
  let finished = false
  let readerReleased = false

  const finish = () => {
    if (finished) return
    finished = true
    lifecycle.finish()
  }

  const releaseReader = () => {
    if (readerReleased) return
    readerReleased = true
    reader.releaseLock()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await readWithLifecycle(reader, lifecycle, options)
        if (result.done) {
          finish()
          releaseReader()
          controller.close()
          return
        }

        controller.enqueue(result.value)
      } catch (error) {
        const reason = lifecycle.finishWithError(error)
        finish()
        await reader.cancel(reason).catch(() => {})
        releaseReader()
        controller.error(reason)
      }
    },
    async cancel(reason) {
      const error = toAbortReason(reason)
      lifecycle.abort(error)
      finish()
      await reader.cancel(error).catch(() => {})
      releaseReader()
    },
  })
}

const readWithLifecycle = async (
  reader: {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>
  },
  lifecycle: RequestLifecycle,
  options: UpstreamHttpLifecycleOptions,
): Promise<{ done: boolean; value?: Uint8Array }> =>
  await new Promise((resolve, reject) => {
    let settled = false
    const signal = lifecycle.signal
    const timer = setTimeout(() => {
      const error = new UpstreamStreamInactivityTimeoutError(
        options.streamInactivityTimeoutMs,
      )
      lifecycle.abort(error)
      settle(() => reject(error))
    }, options.streamInactivityTimeoutMs)
    const onAbort = () => {
      settle(() => reject(toAbortReason(signal.reason)))
    }

    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
    }

    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      action()
    }

    if (signal.aborted) {
      onAbort()
      return
    }

    signal.addEventListener("abort", onAbort, { once: true })
    reader.read().then(
      (result) => settle(() => resolve(result)),
      (error: unknown) => settle(() => reject(toError(error))),
    )
  })

const toAbortReason = (reason: unknown): Error => {
  if (reason instanceof Error) return reason
  const error = new Error("The operation was aborted")
  error.name = "AbortError"
  return error
}

const toError = (value: unknown): Error => {
  if (value instanceof Error) return value
  return new Error(String(value))
}
