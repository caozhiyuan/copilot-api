import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Context } from "hono"
import {
  UpstreamHeadersTimeoutError,
  UpstreamStreamInactivityTimeoutError,
  forwardError,
} from "~/lib/http/error"
import { writeSSEIfConnected } from "~/lib/http/sse"
import { state } from "~/lib/state"
const originalFetch = globalThis.fetch
const originalCopilotToken = state.copilotToken
const originalCodexToken = state.codexAccessToken
const originalCodexAccount = state.codexAccountId
const fetchMock = mock(() =>
  Promise.resolve(new Response("unexpected", { status: 500 })),
)
beforeEach(() => {
  state.copilotToken = "test-token"
  state.codexAccessToken = "codex-token"
  state.codexAccountId = "codex-account"
  fetchMock.mockClear()
  const scope = globalThis as unknown as { fetch: typeof fetch }
  scope.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => {
  state.copilotToken = originalCopilotToken
  state.codexAccessToken = originalCodexToken
  state.codexAccountId = originalCodexAccount
  const scope = globalThis as unknown as { fetch: typeof fetch }
  scope.fetch = originalFetch
})
describe("writeSSEIfConnected", () => {
  test("skips writing when aborted", async () => {
    const writeSSE = mock(() => Promise.resolve())
    const stream = { aborted: true, writeSSE } as unknown as never
    expect(await writeSSEIfConnected(stream, { data: "hello" })).toBe(false)
    expect(writeSSE).not.toHaveBeenCalled()
  })
  test("writes while connected", async () => {
    const writeSSE = mock(() => Promise.resolve())
    const stream = { aborted: false, writeSSE } as unknown as never
    expect(await writeSSEIfConnected(stream, { data: "hello" })).toBe(true)
    expect(writeSSE).toHaveBeenCalledTimes(1)
  })
  test("swallows mid-write disconnect", async () => {
    const writeSSE = mock(() => Promise.reject(new Error("write after end")))
    const stream = { aborted: true, writeSSE } as unknown as never
    expect(await writeSSEIfConnected(stream, { data: "hello" })).toBe(false)
  })
  test("rethrows mid-write failure while connected", () => {
    const failure = new Error("downstream failure")
    const writeSSE = mock(() => Promise.reject(failure))
    const stream = { aborted: false, writeSSE } as unknown as never
    return expect(writeSSEIfConnected(stream, { data: "hello" })).rejects.toBe(
      failure,
    )
  })
})
describe("forwardError timeout precedence", () => {
  const createContext = (signal: AbortSignal) =>
    ({
      header: mock(() => {}),
      json: (payload: unknown, status: number) =>
        Response.json(payload, { status }),
      req: { raw: { signal } },
    }) as unknown as Context
  test("headers timeout after disconnect is 504", async () => {
    const client = new AbortController()
    client.abort()
    const response = await forwardError(
      createContext(client.signal),
      new UpstreamHeadersTimeoutError(5),
    )
    expect(response.status).toBe(504)
    expect(await response.json()).toMatchObject({
      error: { type: "upstream_timeout" },
    })
  })
  test("stream timeout after disconnect is 504", async () => {
    const client = new AbortController()
    client.abort()
    const response = await forwardError(
      createContext(client.signal),
      new UpstreamStreamInactivityTimeoutError(5),
    )
    expect(response.status).toBe(504)
  })
  test("pre-dispatch abort is 499", async () => {
    const client = new AbortController()
    client.abort()
    const response = await forwardError(
      createContext(client.signal),
      new Error("boom"),
    )
    expect(response.status).toBe(499)
  })
})
