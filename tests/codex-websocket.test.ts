import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import type { ResponsesResult } from "../src/services/copilot/create-responses"

type ListenerEvent = {
  data?: string
  error?: unknown
  message?: string
}

type Listener = (event: ListenerEvent) => void

const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static autoComplete = true
  static instances: Array<MockWebSocket> = []

  readonly sent: Array<string> = []
  readonly init: { dispatcher?: unknown; headers?: Record<string, string> }
  readonly url: string
  readyState = MockWebSocket.CONNECTING

  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(
    url: string,
    init: { dispatcher?: unknown; headers?: Record<string, string> },
  ) {
    this.init = init
    this.url = url
    MockWebSocket.instances.push(this)

    originalSetTimeout(() => {
      this.readyState = MockWebSocket.OPEN
      this.emit("open", {})
    }, 0)
  }

  addEventListener(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  removeEventListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener)
  }

  send(data: string): void {
    this.sent.push(data)

    if (MockWebSocket.autoComplete) {
      originalSetTimeout(() => {
        this.completeLatestResponse()
      }, 0)
    }
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }

    this.readyState = MockWebSocket.CLOSED
    this.emit("close", {})
  }

  completeLatestResponse(): void {
    const latestSent = this.sent.at(-1)
    if (!latestSent) {
      throw new Error("No websocket request to complete")
    }

    const parsed = JSON.parse(latestSent) as { model: string }
    this.emit("message", {
      data: JSON.stringify({
        response: createResponsesResult(
          parsed.model,
          `resp-${this.sent.length}`,
        ),
        sequence_number: 1,
        type: "response.completed",
      }),
    })
  }

  private emit(event: string, payload: ListenerEvent): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload)
    }
  }
}

class MockAgent {
  close(): Promise<void> {
    return Promise.resolve()
  }

  destroy(): void {
    /* ignore */
  }
}

class MockProxyAgent extends MockAgent {
  readonly proxyUrl: string

  constructor(proxyUrl: string) {
    super()
    this.proxyUrl = proxyUrl
  }
}

const setGlobalDispatcherMock = mock((_dispatcher: unknown) => {})
const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(new Response("unexpected http", { status: 500 })),
)
const actualUndici = await import("undici")

await mock.module("undici", () => ({
  ...actualUndici,
  Agent: MockAgent,
  ProxyAgent: MockProxyAgent,
  setGlobalDispatcher: setGlobalDispatcherMock,
  WebSocket: MockWebSocket,
}))

const { state } = await import("../src/lib/state")
const { forwardCodexResponses } = await import(
  "../src/services/codex/create-responses"
)

const originalState = {
  codexAccessToken: state.codexAccessToken,
  codexAccountId: state.codexAccountId,
}

const createResponsesResult = (
  model: string,
  id = "resp-test",
): ResponsesResult => ({
  created_at: 0,
  error: null,
  id,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model,
  object: "response",
  output: [],
  output_text: "",
  parallel_tool_calls: false,
  status: "completed",
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: null,
})

const mockFetchJsonResponse = (body: unknown): void => {
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
        status: 200,
      }),
    ),
  )
}

beforeEach(() => {
  MockWebSocket.autoComplete = true
  MockWebSocket.instances = []
  state.codexAccessToken = "codex-token"
  state.codexAccountId = "codex-account"
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  for (const websocket of MockWebSocket.instances) {
    websocket.close()
  }

  state.codexAccessToken = originalState.codexAccessToken
  state.codexAccountId = originalState.codexAccountId
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("forwardCodexResponses falls back to HTTP for non-streaming responses", async () => {
  mockFetchJsonResponse(createResponsesResult("gpt-5.4", "resp-http"))

  const response = await forwardCodexResponses(
    {
      input: "hello",
      model: "gpt-5.4",
    },
    new Headers({
      "content-type": "application/json",
    }),
    undefined,
    {
      transport: "websocket",
    },
  )

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(response).toMatchObject({
    id: "resp-http",
    model: "gpt-5.4",
    status: "completed",
  })
  expect(MockWebSocket.instances).toHaveLength(0)

  const request = fetchMock.mock.calls[0]?.[0]
  const requestInit = fetchMock.mock.calls[0]?.[1]
  if (typeof request !== "string") {
    throw new Error("Expected codex HTTP request URL to be a string")
  }
  if (typeof requestInit?.body !== "string") {
    throw new Error("Expected codex HTTP request body to be a string")
  }

  expect(request).toBe("https://chatgpt.com/backend-api/codex/responses")
  expect(requestInit?.method).toBe("POST")

  const payload = JSON.parse(requestInit.body) as {
    model?: string
    store?: boolean
    stream?: boolean
    type?: string
  }
  expect(payload).toMatchObject({
    model: "gpt-5.4",
    store: false,
  })
  expect(payload.stream).toBeUndefined()
  expect(payload.type).toBeUndefined()

  expect(response).toMatchObject({
    id: "resp-http",
    model: "gpt-5.4",
    status: "completed",
  })
})

test("forwardCodexResponses moves system input messages into instructions for HTTP requests", async () => {
  mockFetchJsonResponse(createResponsesResult("gpt-5.4", "resp-http-system"))

  await forwardCodexResponses(
    {
      input: [
        { role: "system", content: "follow the repo style" },
        { role: "user", content: "hello" },
      ],
      instructions: null,
      model: "gpt-5.4",
    },
    new Headers({
      "content-type": "application/json",
    }),
  )

  expect(fetchMock).toHaveBeenCalledTimes(1)

  const requestInit = fetchMock.mock.calls[0]?.[1]
  if (typeof requestInit?.body !== "string") {
    throw new Error("Expected codex HTTP request body to be a string")
  }

  const payload = JSON.parse(requestInit.body) as {
    input?: Array<{ content?: string; role?: string }>
    instructions?: string | null
  }

  expect(payload.instructions).toBe("follow the repo style")
  expect(payload.input).toEqual([{ role: "user", content: "hello" }])
})

test("forwardCodexResponses returns HTTP event streams when stream=true", async () => {
  fetchMock.mockImplementation(() => {
    return Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult("gpt-5.4", "resp-http-stream"),
            sequence_number: 1,
            type: "response.completed",
          })}`,
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
          },
          status: 200,
        },
      ),
    )
  })

  const response = await forwardCodexResponses(
    {
      input: "hello",
      model: "gpt-5.4",
      stream: true,
    },
    new Headers({
      accept: "text/event-stream",
      "content-type": "application/json",
    }),
    undefined,
    {
      transport: "http",
    },
  )

  const chunks = await collectStreamChunks(response as AsyncIterable<unknown>)

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(MockWebSocket.instances).toHaveLength(0)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("response.completed")
  expect(chunks[0]?.data).toContain('"type":"response.completed"')
})

test("forwardCodexResponses preserves response.completed while using websocket", async () => {
  const response = await forwardCodexResponses(
    {
      input: "hello",
      model: "gpt-5.4",
      stream: true,
    },
    new Headers(),
    undefined,
    {
      transport: "websocket",
    },
  )

  expect(fetchMock).not.toHaveBeenCalled()
  const chunks = await collectStreamChunks(response as AsyncIterable<unknown>)

  expect(MockWebSocket.instances).toHaveLength(1)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("response.completed")
  expect(chunks[0]?.data).toContain('"type":"response.completed"')
})

test("forwardCodexResponses emits an error event when the websocket closes without a terminal response", async () => {
  MockWebSocket.autoComplete = false

  const response = await forwardCodexResponses(
    {
      input: "hello",
      model: "gpt-5.4",
      stream: true,
    },
    new Headers(),
    undefined,
    {
      transport: "websocket",
    },
  )

  expect(fetchMock).not.toHaveBeenCalled()

  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  MockWebSocket.instances[0]?.close()

  const chunks = await chunksPromise

  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain(
    '"message":"Codex responses websocket ended without a terminal response"',
  )
})

const collectStreamChunks = async (
  stream: AsyncIterable<unknown>,
): Promise<Array<{ data?: string; event?: string; id?: string | number }>> => {
  const chunks: Array<{
    data?: string
    event?: string
    id?: string | number
  }> = []

  for await (const chunk of stream as AsyncIterable<{
    data?: string
    event?: string
    id?: string | number
  }>) {
    chunks.push(chunk)
  }

  return chunks
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return
    }

    await new Promise<void>((resolve) => {
      originalSetTimeout(resolve, 0)
    })
  }

  throw new Error("Timed out waiting for condition")
}
