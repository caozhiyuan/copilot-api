import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Hono } from "hono"

import type { ResponsesPayload, ResponsesResult } from "~/lib/types/responses"

type ListenerEvent = {
  data?: string
  error?: unknown
  message?: string
}

type Listener = (event: ListenerEvent) => void

const { requestContext } = await import("~/lib/request-context")
const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static autoComplete = true
  static instances: Array<MockWebSocket> = []
  static responseError: { message: string; statusCode: number } | null = null
  static responseMetadataHeaders: Record<string, unknown> | null = null
  static responseFrames: Array<string> | null = null

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

  emitMessage(frame: object): void {
    this.emit("message", { data: JSON.stringify(frame) })
  }

  completeLatestResponse(): void {
    const latestSent = this.sent.at(-1)
    if (!latestSent) {
      throw new Error("No websocket request to complete")
    }

    const parsed = JSON.parse(latestSent) as { model: string }
    if (MockWebSocket.responseError) {
      this.emit("message", {
        data: JSON.stringify({
          error: { message: MockWebSocket.responseError.message },
          status_code: MockWebSocket.responseError.statusCode,
          type: "error",
        }),
      })
      return
    }

    if (MockWebSocket.responseMetadataHeaders) {
      this.emit("message", {
        data: JSON.stringify({
          type: "codex.rate_limits",
          plan_type: "plus",
        }),
      })
      this.emit("message", {
        data: JSON.stringify({
          type: "test.pre_response",
        }),
      })
      this.emit("message", {
        data: JSON.stringify({
          type: "codex.response.metadata",
          headers: MockWebSocket.responseMetadataHeaders,
        }),
      })
    }
    if (MockWebSocket.responseFrames) {
      for (const data of MockWebSocket.responseFrames) {
        this.emit("message", { data })
      }
      return
    }
    this.emit("message", {
      data: JSON.stringify({
        type: "response.created",
      }),
    })
    if (parsed.model === "gpt-continuation") {
      for (const [outputIndex, item] of continuationOutput.entries()) {
        this.emit("message", {
          data: JSON.stringify({
            type: "response.output_item.done",
            sequence_number: outputIndex + 1,
            output_index: outputIndex,
            item,
          }),
        })
      }
    }
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
const originalWebSocket = globalThis.WebSocket

await mock.module("undici", () => ({
  ...actualUndici,
  Agent: MockAgent,
  ProxyAgent: MockProxyAgent,
  setGlobalDispatcher: setGlobalDispatcherMock,
  WebSocket: MockWebSocket,
}))

const { state } = await import("~/lib/state")
const { traceIdMiddleware } = await import("~/lib/trace")
const { codexResponsesDependencies, forwardCodexResponses } = await import(
  "~/services/codex/create-responses"
)
const { providerResponsesRoutes } = await import(
  "~/routes/provider/responses/route"
)
const { responsesRoutes } = await import("~/routes/responses/route")
const { providerResponsesHandlerDependencies } = await import(
  "~/routes/provider/responses/handler"
)

const originalState = {
  codexAccessToken: state.codexAccessToken,
  codexAccountId: state.codexAccountId,
}
const originalIsResponsesApiWebSocketEnabled =
  codexResponsesDependencies.isResponsesApiWebSocketEnabled

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
  output:
    model === "gpt-continuation" ?
      continuationOutput.map((item) =>
        item.type === "reasoning" ?
          { ...item, encrypted_content: "completed-cipher" }
        : item,
      )
    : [],
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
  globalThis.WebSocket = MockWebSocket as unknown as typeof globalThis.WebSocket
  MockWebSocket.autoComplete = true
  MockWebSocket.instances = []
  MockWebSocket.responseError = null
  MockWebSocket.responseMetadataHeaders = null
  MockWebSocket.responseFrames = null
  // Other test files mock ~/lib/config with websockets disabled, and Bun keeps
  // module mocks for the whole run, so pin the configured transport here.
  codexResponsesDependencies.isResponsesApiWebSocketEnabled = () => true
  state.codexAccessToken = "codex-token"
  state.codexAccountId = "codex-account"
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  globalThis.WebSocket = originalWebSocket
  for (const websocket of MockWebSocket.instances) {
    websocket.close()
  }

  codexResponsesDependencies.isResponsesApiWebSocketEnabled =
    originalIsResponsesApiWebSocketEnabled
  state.codexAccessToken = originalState.codexAccessToken
  state.codexAccountId = originalState.codexAccountId
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("forwardCodexResponses falls back to HTTP for non-streaming responses", async () => {
  mockFetchJsonResponse(createResponsesResult("gpt-5.4", "resp-http"))
  const downstream = new AbortController()

  const response = await forwardCodexResponses(
    {
      input: "hello",
      model: "gpt-5.4",
    },
    new Headers({
      "content-type": "application/json",
      "x-codex-routing-hint": "model=stale-model",
    }),
    undefined,
    {
      clientSignal: downstream.signal,
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
  expect(new Headers(requestInit.headers).get("x-codex-routing-hint")).toBe(
    "model=gpt-5.4",
  )
  expect(requestInit?.signal).toBeInstanceOf(AbortSignal)
  expect(requestInit?.signal?.aborted).toBe(false)

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
  downstream.abort()
  expect(requestInit?.signal?.aborted).toBe(false)
})

test("Codex HTTP routes using the requested model and service tier", async () => {
  mockFetchJsonResponse(createResponsesResult("gpt-5.3-codex"))

  await forwardCodexResponses(
    { model: "gpt-5.3-codex", service_tier: "priority" },
    new Headers({ "x-codex-routing-hint": "model=stale-model;tier=default" }),
    undefined,
    { transport: "http" },
  )

  expect(fetchMock).toHaveBeenCalledTimes(1)
  const requestInit = fetchMock.mock.calls[0]?.[1]
  expect(new Headers(requestInit?.headers).get("x-codex-routing-hint")).toBe(
    "model=gpt-5.3-codex;tier=priority",
  )
  expect(requestInit?.body).toContain('"service_tier":"priority"')
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
  expect(
    new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
      "x-codex-routing-hint",
    ),
  ).toBe("model=gpt-5.4")
  expect(MockWebSocket.instances).toHaveLength(0)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("response.completed")
  expect(chunks[0]?.data).toContain('"type":"response.completed"')
})

test("forwardCodexResponses cancels and unlocks an HTTP body after a terminal event", async () => {
  let cancelledBodies = 0
  const upstreamBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          [
            "event: response.completed",
            `data: ${JSON.stringify({
              response: createResponsesResult("gpt-5.4", "resp-http-terminal"),
              sequence_number: 1,
              type: "response.completed",
            })}`,
            "",
            "",
          ].join("\n"),
        ),
      )
    },
    cancel() {
      cancelledBodies += 1
    },
  })
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(upstreamBody, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
        },
        status: 200,
      }),
    ),
  )

  const response = await forwardCodexResponses(
    {
      input: "hello",
      model: "gpt-5.4",
      stream: true,
    },
    new Headers({ accept: "text/event-stream" }),
    undefined,
    { transport: "http" },
  )

  const chunks: Array<{ data?: string; event?: string }> = []
  for await (const chunk of response as AsyncIterable<{
    data?: string
    event?: string
  }>) {
    chunks.push(chunk)
    break
  }

  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("response.completed")
  expect(cancelledBodies).toBe(1)
  expect(upstreamBody.locked).toBe(false)
})

test("forwardCodexResponses preserves response lifecycle events", async () => {
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
  expect(chunks.map((chunk) => chunk.event)).toEqual([
    "response.created",
    "response.completed",
  ])
})

test("Codex reuses a thread across client metadata changes and refreshes send metadata", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_000)
  const clientMetadata = {
    existing: "preserved",
    "x-codex-ws-stream-request-start-ms": "stale",
  }
  const headers = new Headers({
    "user-agent": "CoDeX-tui/0.155.1 (Linux)",
    "thread-id": "thread-1",
    "x-openai-internal-codex-responses-lite": "false",
    "x-codex-turn-state": "turn-state-websocket-123",
    "x-codex-routing-hint": "model=stale-model",
  })

  try {
    for (const sendTime of [2_000, 4_000]) {
      headers.set("x-client-request-id", `request-${sendTime}`)
      headers.set("session-id", `session-${sendTime}`)
      headers.set("x-codex-window-id", `window-${sendTime}`)
      if (sendTime === 4_000) {
        headers.set("user-agent", "codex-desktop/1.0")
        headers.set("version", "1.0")
      }
      const response = await forwardCodexResponses(
        {
          client_metadata: clientMetadata,
          input: "hello",
          model: "gpt-5.4",
          service_tier: "priority",
          stream: true,
        },
        headers,
        undefined,
        { transport: "websocket" },
      )
      now.mockReturnValue(sendTime)
      await collectStreamChunks(response as AsyncIterable<unknown>)
    }

    expect(MockWebSocket.instances).toHaveLength(1)
    const websocket = MockWebSocket.instances[0]
    expect(websocket?.init.headers?.version).toBe("0.155.1")
    expect(websocket?.init.headers?.["x-codex-routing-hint"]).toBe(
      "model=gpt-5.4;tier=priority",
    )
    expect(websocket?.init.headers).not.toHaveProperty(
      "x-openai-internal-codex-responses-lite",
    )
    expect(websocket?.init.headers).not.toHaveProperty("x-codex-turn-state")
    expect(websocket?.sent).toHaveLength(2)
    const sent = websocket?.sent.map(
      (data) => JSON.parse(data) as ResponsesPayload,
    )
    expect(sent?.map((payload) => payload.client_metadata)).toEqual([
      {
        existing: "preserved",
        "x-codex-ws-stream-request-start-ms": "2000",
        ws_request_header_x_openai_internal_codex_responses_lite: "false",
      },
      {
        existing: "preserved",
        "x-codex-ws-stream-request-start-ms": "4000",
        ws_request_header_x_openai_internal_codex_responses_lite: "false",
      },
    ])
    expect(clientMetadata["x-codex-ws-stream-request-start-ms"]).toBe("stale")
  } finally {
    now.mockRestore()
  }
})

test("provider Responses forwards Codex websocket metadata as HTTP headers", async () => {
  const originalResolveProviderConfig =
    providerResponsesHandlerDependencies.resolveProviderConfig
  MockWebSocket.responseMetadataHeaders = {
    "content-type": "application/unsafe",
    "proxy-authenticate": "Basic",
    "x-codex-safety-buffering-enabled": "true",
    "x-codex-safety-buffering-faster-model": "gpt-5.6-luna",
    "x-codex-turn-state": "turn-state-websocket-123",
    "x-models-etag": 'W/"cc84b142c478d2fdd3d1257f1a8eefc2"',
    "x-custom-metadata": "forward-me",
  }
  const instructions = "x".repeat(256 * 1024)
  const frames = [
    "response.created",
    "response.in_progress",
    "response.completed",
  ].map(
    (type, sequence_number) =>
      ` ${JSON.stringify({
        type,
        sequence_number,
        response: {
          ...createResponsesResult("gpt-5.4"),
          instructions,
          status: type === "response.completed" ? "completed" : "in_progress",
        },
      })} `,
  )
  MockWebSocket.responseFrames = frames
  providerResponsesHandlerDependencies.resolveProviderConfig = () =>
    Promise.resolve({
      apiKey: "",
      authType: "oauth2",
      baseUrl: "https://chatgpt.example/backend-api",
      models: { "gpt-5.4": {} },
      name: "codex",
      type: "openai-responses",
    })

  const parseSpy = spyOn(JSON, "parse")
  try {
    const app = new Hono()
    app.use(traceIdMiddleware)
    app.route("/:provider/v1/responses", providerResponsesRoutes)
    const response = await app.request("/codex/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-5.4",
        stream: true,
      }),
      headers: {
        "content-type": "application/json",
        "thread-id": "large-lifecycle",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-codex-turn-state")).toBe(
      "turn-state-websocket-123",
    )
    expect(response.headers.get("x-codex-safety-buffering-enabled")).toBe(
      "true",
    )
    expect(response.headers.get("x-codex-safety-buffering-faster-model")).toBe(
      "gpt-5.6-luna",
    )
    expect(response.headers.get("x-custom-metadata")).toBe("forward-me")
    expect(response.headers.get("proxy-authenticate")).toBeNull()
    expect(response.headers.get("content-type")).toContain("text/event-stream")

    const body = await response.text()
    const rateLimitsIndex = body.indexOf("codex.rate_limits")
    const preResponseIndex = body.indexOf("test.pre_response")
    const responseCreatedIndex = body.indexOf("response.created")
    const responseCompletedIndex = body.indexOf("response.completed")
    expect(rateLimitsIndex).toBeGreaterThanOrEqual(0)
    expect(preResponseIndex).toBeGreaterThan(rateLimitsIndex)
    expect(responseCreatedIndex).toBeGreaterThan(preResponseIndex)
    expect(responseCompletedIndex).toBeGreaterThan(responseCreatedIndex)
    expect(body).toContain("response.completed")
    expect(body).not.toContain("codex.response.metadata")
    for (const data of frames) {
      expect(body).toContain(`data: ${data}\n`)
      expect(
        parseSpy.mock.calls.filter(([input]) => input === data),
      ).toHaveLength(1)
    }
  } finally {
    parseSpy.mockRestore()
    providerResponsesHandlerDependencies.resolveProviderConfig =
      originalResolveProviderConfig
  }
})

test("provider Responses handles a first Codex websocket error without metadata", async () => {
  const originalResolveProviderConfig =
    providerResponsesHandlerDependencies.resolveProviderConfig
  MockWebSocket.responseError = {
    message: "Codex quota exceeded",
    statusCode: 429,
  }
  providerResponsesHandlerDependencies.resolveProviderConfig = () =>
    Promise.resolve({
      apiKey: "",
      authType: "oauth2",
      baseUrl: "https://chatgpt.example/backend-api",
      models: { "gpt-5.4": {} },
      name: "codex",
      type: "openai-responses",
    })

  try {
    const app = new Hono()
    app.route("/:provider/v1/responses", providerResponsesRoutes)
    const response = await app.request("/codex/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-5.4",
        stream: true,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      error: { message: "Codex quota exceeded" },
    })
  } finally {
    providerResponsesHandlerDependencies.resolveProviderConfig =
      originalResolveProviderConfig
  }
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
    '"message":"Codex responses websocket ended without a terminal response, retry your request."',
  )
})

test("Codex without Responses Lite drains an active websocket after client cancellation", async () => {
  MockWebSocket.autoComplete = false
  const controller = new AbortController()
  const response = await requestContext.run(
    {
      traceId: "non-lite-abort",
      startTime: Date.now(),
      userAgent: "codex-tui",
      sessionAffinity: "non-lite-thread",
      rootSessionId: "non-lite-thread",
      parentSessionId: undefined,
    },
    () =>
      forwardCodexResponses(
        { input: "hello", model: "gpt-5.4", stream: true },
        new Headers({ "x-openai-internal-codex-responses-lite": "false" }),
        undefined,
        { clientSignal: controller.signal, transport: "websocket" },
      ),
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const socket = MockWebSocket.instances[0]
  socket.emitMessage({ type: "response.created", response: { id: "resp-1" } })
  controller.abort()
  await delay(0)
  expect(socket.sent).toHaveLength(1)
  expect(socket.readyState).toBe(MockWebSocket.OPEN)

  socket.completeLatestResponse()
  const chunks = await chunksPromise
  expect(chunks.at(-1)?.event).toBe("response.completed")
  expect(socket.readyState).toBe(MockWebSocket.OPEN)
})

test("top-level Codex Responses Lite interrupts after SSE disconnect and continues on the same socket", async () => {
  const originalResolveProviderConfig =
    providerResponsesHandlerDependencies.resolveProviderConfig
  providerResponsesHandlerDependencies.resolveProviderConfig = () =>
    Promise.resolve({
      apiKey: "",
      authType: "oauth2",
      baseUrl: "https://chatgpt.example/backend-api",
      models: { "gpt-continuation": {} },
      name: "codex",
      type: "openai-responses",
    })

  try {
    const app = new Hono()
    app.use(traceIdMiddleware)
    app.route("/responses", responsesRoutes)
    const sendTurn = (input: ResponsesPayload["input"]) =>
      app.request("/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "thread-id": "interrupted-thread",
          "user-agent": "codex-tui/0.167.0",
          "x-openai-internal-codex-responses-lite": "true",
        },
        body: JSON.stringify({
          input,
          model: "codex/gpt-continuation",
          stream: true,
        }),
      })

    const first = { type: "message", role: "user", content: "first" } as const
    const second = { ...first, content: "second" }
    const next = { ...first, content: "follow-up" }
    expect(await (await sendTurn([first])).text()).toContain('"id":"resp-1"')
    const socket = MockWebSocket.instances[0]
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      model: "gpt-continuation",
      client_metadata: {
        ws_request_header_x_openai_internal_codex_responses_lite: "true",
      },
    })

    MockWebSocket.autoComplete = false
    const history = [first, ...continuationOutput, second]
    const interrupted = sendTurn(history)
    await waitFor(() => socket.sent.length === 2)
    expect(JSON.parse(socket.sent[1])).toMatchObject({
      previous_response_id: "resp-1",
      input: [second],
    })
    socket.emitMessage({ type: "response.created", response: { id: "resp-2" } })
    const response = await interrupted
    expect(response.status).toBe(200)
    await response.body?.cancel()
    await waitFor(() => socket.sent.length === 3)
    expect(JSON.parse(socket.sent[2])).toEqual({
      type: "response.interrupt",
      response_id: "resp-2",
      mode: "discard_partial_items",
    })

    MockWebSocket.autoComplete = true
    const followUp = sendTurn([...history, next])
    socket.emitMessage({
      type: "response.interrupt.accepted",
      response_id: "resp-2",
    })
    await delay(0)
    expect(socket.sent).toHaveLength(3)
    expect(MockWebSocket.instances).toHaveLength(1)
    socket.emitMessage({
      type: "response.completed",
      response: createResponsesResult("gpt-continuation", "resp-2"),
    })

    expect(await (await followUp).text()).toContain('"id":"resp-4"')
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(JSON.parse(socket.sent[3])).toMatchObject({
      type: "response.create",
      previous_response_id: "resp-1",
      input: [second, next],
    })
  } finally {
    providerResponsesHandlerDependencies.resolveProviderConfig =
      originalResolveProviderConfig
  }
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

const delay = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => originalSetTimeout(resolve, milliseconds))

test("Codex websocket automatically continues a stable non-Codex user agent", async () => {
  await requestContext.run(
    {
      traceId: "continuation",
      startTime: Date.now(),
      userAgent: "claude-code",
      sessionAffinity: "root:child",
      rootSessionId: "root",
      parentSessionId: undefined,
    },
    async () => {
      const first = { type: "message", role: "user", content: "hello" } as const
      for (const input of [[first], [first, ...continuationOutput, first]]) {
        const stream = await forwardCodexResponses(
          { model: "gpt-continuation", stream: true, input },
          new Headers({ "user-agent": "claude-code" }),
          undefined,
          { transport: "websocket" },
        )
        for await (const _chunk of stream as AsyncIterable<unknown>) {
          /* consume */
        }
      }
    },
  )
  expect(MockWebSocket.instances).toHaveLength(1)
  expect(JSON.parse(MockWebSocket.instances[0].sent[1])).toMatchObject({
    previous_response_id: "resp-1",
    input: [{ type: "message", role: "user", content: "hello" }],
  })
})

const continuationOutput = [
  {
    type: "reasoning",
    id: "server-reasoning",
    encrypted_content: "cipher",
    summary: [],
  },
  {
    type: "message",
    id: "server-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "answer", annotations: [] }],
  },
] satisfies ResponsesResult["output"]
