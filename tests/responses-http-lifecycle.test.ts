import { afterEach, expect, mock, test } from "bun:test"

import {
  defaultResponsesTransportConfig,
  normalizeResponsesTransportConfig,
} from "~/lib/config"
import {
  fetchResponsesWithLifecycle,
  ResponsesHeadersTimeoutError,
  ResponsesStreamInactivityTimeoutError,
} from "~/services/responses-http"

const originalFetch = globalThis.fetch

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("Responses transport configuration validates positive integer limits", () => {
  expect(
    normalizeResponsesTransportConfig({
      headersTimeoutMs: 12.8,
      streamInactivityTimeoutMs: 0,
      websocketMaxBufferedBytes: -1,
      websocketMaxBufferedMessages: Number.NaN,
      websocketOpenTimeoutMs: 45,
    }),
  ).toEqual({
    ...defaultResponsesTransportConfig,
    headersTimeoutMs: 12,
    websocketOpenTimeoutMs: 45,
  })
})

test("downstream cancellation aborts only its upstream HTTP request", async () => {
  const upstreamSignals: Array<AbortSignal> = []
  let cancelledBodies = 0
  const fetchMock = mock(
    (_input: string | URL | Request, init?: RequestInit) => {
      upstreamSignals.push(init?.signal as AbortSignal)
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event"))
            },
            cancel() {
              cancelledBodies += 1
            },
          }),
        ),
      )
    },
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const firstController = new AbortController()
  const secondController = new AbortController()
  const firstResponse = await fetchResponsesWithLifecycle(
    "https://first.example/responses",
    { method: "POST" },
    lifecycleOptions(firstController.signal),
  )
  const secondResponse = await fetchResponsesWithLifecycle(
    "https://second.example/responses",
    { method: "POST" },
    lifecycleOptions(secondController.signal),
  )
  const firstReader = firstResponse.body!.getReader()
  const secondReader = secondResponse.body!.getReader()

  await firstReader.read()
  await secondReader.read()
  firstController.abort(new Error("client disconnected"))

  expect(await getRejectedError(firstReader.read())).toHaveProperty(
    "message",
    "client disconnected",
  )
  expect(cancelledBodies).toBe(1)
  expect(upstreamSignals[0]?.aborted).toBe(true)
  expect(upstreamSignals[1]?.aborted).toBe(false)

  secondController.abort(new Error("test cleanup"))
  expect(await getRejectedError(secondReader.read())).toHaveProperty(
    "message",
    "test cleanup",
  )
  expect(cancelledBodies).toBe(2)
})

test("normal HTTP body completion removes downstream cancellation linkage", async () => {
  let upstreamSignal: AbortSignal | undefined
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(
    (_input: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal
      return Promise.resolve(Response.json({ ok: true }))
    },
  ) as unknown as typeof fetch

  const downstream = new AbortController()
  const response = await fetchResponsesWithLifecycle(
    "https://upstream.example/responses",
    { method: "POST" },
    lifecycleOptions(downstream.signal),
  )

  expect(await response.json()).toEqual({ ok: true })
  expect(upstreamSignal?.aborted).toBe(false)
  downstream.abort(new Error("too late"))
  expect(upstreamSignal?.aborted).toBe(false)
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
      fetchResponsesWithLifecycle(
        "https://upstream.example/responses",
        { method: "POST" },
        {
          headersTimeoutMs: 5,
          streamInactivityTimeoutMs: 100,
        },
      ),
    ),
  ).toBeInstanceOf(ResponsesHeadersTimeoutError)
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

  const response = await fetchResponsesWithLifecycle(
    "https://upstream.example/responses",
    { method: "POST" },
    {
      headersTimeoutMs: 100,
      streamInactivityTimeoutMs: 5,
    },
  )

  expect(
    await getRejectedError(response.body!.getReader().read()),
  ).toBeInstanceOf(ResponsesStreamInactivityTimeoutError)
  expect(upstreamSignal?.aborted).toBe(true)
})

const lifecycleOptions = (
  signal: AbortSignal,
): {
  headersTimeoutMs: number
  signal: AbortSignal
  streamInactivityTimeoutMs: number
} => ({
  headersTimeoutMs: 1000,
  signal,
  streamInactivityTimeoutMs: 1000,
})

const getRejectedError = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error("Expected promise to reject")
}
