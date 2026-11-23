import { afterEach, expect, mock, test } from "bun:test"

import {
  defaultUpstreamTransportConfig,
  normalizeUpstreamTransportConfig,
} from "~/lib/config"
import {
  UpstreamHeadersTimeoutError,
  UpstreamStreamInactivityTimeoutError,
} from "~/lib/http/error"
import { createResponsesHttpEventStream } from "~/services/responses-http"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"

const originalFetch = globalThis.fetch

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("upstream transport configuration validates positive integer limits", () => {
  expect(
    normalizeUpstreamTransportConfig({
      headersTimeoutMs: 12.8,
      streamInactivityTimeoutMs: 0,
      websocketMaxBufferedBytes: -1,
      websocketMaxBufferedMessages: Number.NaN,
      websocketOpenTimeoutMs: 45,
      websocketPoolIdleTimeoutMs: 0.5,
    }),
  ).toEqual({
    ...defaultUpstreamTransportConfig,
    headersTimeoutMs: 12,
    websocketOpenTimeoutMs: 45,
  })
})

test("the websocket pool defaults to 270 seconds and honors an explicit timeout", () => {
  expect(
    normalizeUpstreamTransportConfig(undefined).websocketPoolIdleTimeoutMs,
  ).toBe(270_000)
  expect(
    normalizeUpstreamTransportConfig({ websocketPoolIdleTimeoutMs: 60_000 })
      .websocketPoolIdleTimeoutMs,
  ).toBe(60_000)
})

test("a client cancelled before dispatch does not call fetch", async () => {
  const fetchMock = mock(() => Promise.resolve(Response.json({ ok: true })))
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
  const client = new AbortController()
  client.abort()

  expect(
    await getRejectedError(
      fetchUpstreamWithLifecycle(
        "https://upstream.example/responses",
        { method: "POST" },
        lifecycleOptions(client.signal),
      ),
    ),
  ).toHaveProperty("name", "AbortError")
  expect(fetchMock).not.toHaveBeenCalled()
})

test("client cancellation while awaiting headers does not abort upstream", async () => {
  const headers = createDeferred<Response>()
  let upstreamSignal: AbortSignal | undefined
  const fetchMock = mock(
    (_input: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal
      return headers.promise
    },
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
  const client = new AbortController()

  const responsePromise = fetchUpstreamWithLifecycle(
    "https://upstream.example/responses",
    { method: "POST" },
    lifecycleOptions(client.signal),
  )
  client.abort(new Error("client disconnected"))

  expect(upstreamSignal?.aborted).toBe(false)
  headers.resolve(Response.json({ ok: true }))
  expect(await (await responsePromise).json()).toEqual({ ok: true })
  expect(upstreamSignal?.aborted).toBe(false)
})

test("client cancellation after headers continues draining the body", async () => {
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
  let upstreamSignal: AbortSignal | undefined
  let cancelledBodies = 0
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(
    (_input: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller
            },
            cancel() {
              cancelledBodies += 1
            },
          }),
        ),
      )
    },
  ) as unknown as typeof fetch
  const client = new AbortController()
  const response = await fetchUpstreamWithLifecycle(
    "https://upstream.example/responses",
    { method: "POST" },
    lifecycleOptions(client.signal),
  )
  const reader = response.body!.getReader()
  const firstRead = reader.read()

  client.abort(new Error("client disconnected"))
  bodyController?.enqueue(new TextEncoder().encode("continued"))

  const firstResult = await firstRead
  const firstValue = firstResult.value as Uint8Array | undefined
  expect(firstValue).toBeDefined()
  expect(new TextDecoder().decode(firstValue as Uint8Array)).toBe("continued")
  expect(upstreamSignal?.aborted).toBe(false)
  expect(cancelledBodies).toBe(0)

  bodyController?.close()
  expect((await reader.read()).done).toBe(true)
  expect(upstreamSignal?.aborted).toBe(false)
})

test("early SSE iterator return cancels the managed upstream body", async () => {
  let cancelledBodies = 0
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: response.completed\ndata: {"type":"response.completed"}\n\n',
              ),
            )
          },
          cancel() {
            cancelledBodies += 1
          },
        }),
      ),
    ),
  ) as unknown as typeof fetch

  const response = await fetchUpstreamWithLifecycle(
    "https://upstream.example/responses",
    { method: "POST" },
    lifecycleOptions(),
  )
  const iterator =
    createResponsesHttpEventStream(response)[Symbol.asyncIterator]()

  expect((await iterator.next()).value).toHaveProperty(
    "event",
    "response.completed",
  )
  await iterator.return?.()

  expect(cancelledBodies).toBe(1)
  expect(response.body?.locked).toBe(false)
})

test("concurrent upstream lifecycles use independent controllers", async () => {
  const upstreamSignals: Array<AbortSignal> = []
  const bodyControllers: Array<ReadableStreamDefaultController<Uint8Array>> = []
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(
    (_input: string | URL | Request, init?: RequestInit) => {
      upstreamSignals.push(init?.signal as AbortSignal)
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyControllers.push(controller)
              controller.enqueue(new TextEncoder().encode("event"))
            },
          }),
        ),
      )
    },
  ) as unknown as typeof fetch

  const firstResponse = await fetchUpstreamWithLifecycle(
    "https://first.example/responses",
    { method: "POST" },
    lifecycleOptions(),
  )
  const secondResponse = await fetchUpstreamWithLifecycle(
    "https://second.example/responses",
    { method: "POST" },
    lifecycleOptions(),
  )
  const firstReader = firstResponse.body!.getReader()
  const secondReader = secondResponse.body!.getReader()
  await firstReader.read()
  await secondReader.read()

  await firstReader.cancel(new Error("first finished early"))

  expect(upstreamSignals[0]?.aborted).toBe(true)
  expect(upstreamSignals[1]?.aborted).toBe(false)

  bodyControllers[1]?.close()
  expect((await secondReader.read()).done).toBe(true)
})

test("HTTP headers deadline aborts a stalled fetch with an actionable error", async () => {
  let upstreamSignal: AbortSignal | undefined
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(
    (_input: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener(
          "abort",
          () =>
            reject(
              upstreamSignal?.reason instanceof Error ?
                upstreamSignal.reason
              : new Error("HTTP request aborted"),
            ),
          { once: true },
        )
      })
    },
  ) as unknown as typeof fetch

  expect(
    await getRejectedError(
      fetchUpstreamWithLifecycle(
        "https://upstream.example/responses",
        { method: "POST" },
        {
          headersTimeoutMs: 5,
          streamInactivityTimeoutMs: 100,
        },
      ),
    ),
  ).toBeInstanceOf(UpstreamHeadersTimeoutError)
  expect(upstreamSignal?.aborted).toBe(true)
})

test("HTTP stream inactivity aborts stalled body consumption", async () => {
  let upstreamSignal: AbortSignal | undefined
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(
    (_input: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal
      return Promise.resolve(
        new Response(new ReadableStream<Uint8Array>({ start() {} })),
      )
    },
  ) as unknown as typeof fetch

  const response = await fetchUpstreamWithLifecycle(
    "https://upstream.example/responses",
    { method: "POST" },
    {
      headersTimeoutMs: 100,
      streamInactivityTimeoutMs: 5,
    },
  )

  expect(
    await getRejectedError(response.body!.getReader().read()),
  ).toBeInstanceOf(UpstreamStreamInactivityTimeoutError)
  expect(upstreamSignal?.aborted).toBe(true)
})

test("periodic body data can outlive one inactivity window", async () => {
  const encoder = new TextEncoder()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const chunk of ["a", "b", "c", "d"]) {
              controller.enqueue(encoder.encode(chunk))
              await delay(8)
            }
            controller.close()
          },
        }),
      ),
    ),
  ) as unknown as typeof fetch

  const response = await fetchUpstreamWithLifecycle(
    "https://upstream.example/responses",
    { method: "POST" },
    {
      headersTimeoutMs: 100,
      streamInactivityTimeoutMs: 20,
    },
  )

  expect(await response.text()).toBe("abcd")
})

const lifecycleOptions = (
  clientSignal?: AbortSignal,
): {
  clientSignal?: AbortSignal
  headersTimeoutMs: number
  streamInactivityTimeoutMs: number
} => ({
  clientSignal,
  headersTimeoutMs: 1000,
  streamInactivityTimeoutMs: 1000,
})

const createDeferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const delay = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds))

const getRejectedError = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error("Expected promise to reject")
}
