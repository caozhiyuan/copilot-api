import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ResponsesPayload, ResponsesResult } from "~/lib/types/responses"

type ListenerEvent = {
  data?: unknown
  error?: unknown
  message?: string
}

type Listener = (event: ListenerEvent) => void

type MockWebSocketInit = {
  headers?: Record<string, string>
  proxy?: string
}

const originalClearTimeout = globalThis.clearTimeout
const originalSetTimeout = globalThis.setTimeout
const proxyEnvKeys = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "npm_config_http_proxy",
  "NPM_CONFIG_HTTP_PROXY",
  "npm_config_https_proxy",
  "NPM_CONFIG_HTTPS_PROXY",
  "npm_config_proxy",
  "NPM_CONFIG_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
  "npm_config_no_proxy",
  "NPM_CONFIG_NO_PROXY",
] as const

type ProxyEnvKey = (typeof proxyEnvKeys)[number]

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static continuationError: { code: string; param?: string } | null = null
  static errorAfterCreated = false
  static autoComplete = true
  static closeAfterComplete = false
  static failOpen = false
  static failOpenEvent: ListenerEvent | null = null
  static neverOpen = false
  static openDelayMs = 0
  static instances: Array<MockWebSocket> = []

  readonly sent: Array<string> = []
  readonly init: MockWebSocketInit
  readonly url: string
  readyState = MockWebSocket.CONNECTING

  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(url: string, init: MockWebSocketInit) {
    this.init = init
    this.url = url
    MockWebSocket.instances.push(this)
    originalSetTimeout(() => {
      if (MockWebSocket.neverOpen) return
      if (MockWebSocket.failOpen) {
        this.readyState = MockWebSocket.CLOSED
        this.emit("error", MockWebSocket.failOpenEvent ?? {})
        return
      }

      this.readyState = MockWebSocket.OPEN
      this.emit("open", {})
    }, MockWebSocket.openDelayMs)
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
      const payload = JSON.parse(data) as ResponsesPayload & { type?: string }
      if (payload.type === "response.interrupt") return
      originalSetTimeout(() => {
        if (payload.previous_response_id && MockWebSocket.continuationError) {
          if (MockWebSocket.errorAfterCreated)
            this.emitMessage(JSON.stringify({ type: "response.created" }))
          this.emitMessage(
            JSON.stringify({
              type: "error",
              error: {
                ...MockWebSocket.continuationError,
                message: "continuation unavailable",
              },
            }),
          )
        } else this.completeLatestResponse()
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

  emitError(payload: ListenerEvent): void {
    this.emit("error", payload)
  }

  emitMessage(data: unknown): void {
    this.emit("message", { data })
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }

  completeLatestResponse(): void {
    const latestSent = this.sent.at(-1)
    if (!latestSent) {
      throw new Error("No websocket request to complete")
    }

    const parsed = JSON.parse(latestSent) as { model: string }
    if (parsed.model === "gpt-continuation") {
      for (const [outputIndex, item] of continuationOutput.entries()) {
        this.emitMessage(
          JSON.stringify({
            type: "response.output_item.done",
            sequence_number: outputIndex + 1,
            output_index: outputIndex,
            item,
          }),
        )
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

    if (MockWebSocket.closeAfterComplete) {
      originalSetTimeout(() => {
        this.close()
      }, 0)
    }
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

  destroy(): void {}
}

class MockProxyAgent extends MockAgent {
  readonly proxyUrl: string

  constructor(proxyUrl: string) {
    super()
    this.proxyUrl = proxyUrl
  }
}

const setGlobalDispatcherMock = mock((_dispatcher: unknown) => {})
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
const { getConfig, invalidateConfigCache } = await import("~/lib/config")
const { PATHS } = await import("~/lib/paths")
const { createResponses } = await import("~/services/copilot/create-responses")
const {
  createPooledWebSocketStream,
  ResponsesWebSocketInactivityTimeoutError,
  ResponsesWebSocketOpenTimeoutError,
  WebSocketMessageBuffer,
} = await import("~/services/responses-websocket")
const { createResponsesSafeStream, getResponsesStreamTerminalDisposition } =
  await import("~/services/responses-websocket-helpers")

const originalState = {
  accountType: state.accountType,
  copilotApiUrl: state.copilotApiUrl,
  copilotToken: state.copilotToken,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeVersion: state.vsCodeVersion,
}
const { requestContext } = await import("~/lib/request-context")
const originalConfigPath = PATHS.CONFIG_PATH
let configDir: string

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

beforeEach(() => {
  configDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "responses-websocket-config-"),
  )
  PATHS.CONFIG_PATH = path.join(configDir, "config.json")
  fs.writeFileSync(PATHS.CONFIG_PATH, "{}")
  invalidateConfigCache()
  globalThis.WebSocket = MockWebSocket as unknown as typeof globalThis.WebSocket
  MockWebSocket.autoComplete = true
  MockWebSocket.continuationError = null
  MockWebSocket.errorAfterCreated = false
  MockWebSocket.closeAfterComplete = false
  MockWebSocket.failOpen = false
  MockWebSocket.failOpenEvent = null
  MockWebSocket.neverOpen = false
  MockWebSocket.openDelayMs = 0
  MockWebSocket.instances = []
  state.accountType = "individual"
  state.copilotApiUrl = "https://api.githubcopilot.com"
  state.copilotToken = "test-token"
  state.vsCodeDeviceId = "device-1"
  state.vsCodeVersion = "1.120.0"
})

afterEach(() => {
  PATHS.CONFIG_PATH = originalConfigPath
  invalidateConfigCache()
  fs.rmSync(configDir, { recursive: true, force: true })
  globalThis.WebSocket = originalWebSocket
  MockWebSocket.autoComplete = true
  MockWebSocket.closeAfterComplete = false
  MockWebSocket.failOpen = false
  MockWebSocket.failOpenEvent = null
  MockWebSocket.neverOpen = false
  MockWebSocket.openDelayMs = 0
  for (const websocket of MockWebSocket.instances) {
    websocket.close()
  }

  state.accountType = originalState.accountType
  state.copilotApiUrl = originalState.copilotApiUrl
  state.copilotToken = originalState.copilotToken
  state.vsCodeDeviceId = originalState.vsCodeDeviceId
  state.vsCodeVersion = originalState.vsCodeVersion
  ;(
    globalThis as unknown as { clearTimeout: typeof clearTimeout }
  ).clearTimeout = originalClearTimeout
  ;(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
    originalSetTimeout
})

test.each([
  { models: undefined },
  { models: [] },
  { models: ["gpt-6-astra"] },
  { models: ["gpt-6-luna-preview"] },
])(
  "Responses websocket preserves output token replay include for unlisted models with config %j",
  async ({ models }) => {
    getConfig().noEncryptedOutputModels = models
    const payload: ResponsesPayload = {
      include: ["reasoning.encrypted_content", "output.encrypted_content"],
      input: "hello",
      model: "gpt-6-luna",
      stream: true,
    }

    const response = await createResponses(payload, {
      initiator: "user",
      requestId: "request-output-replay",
      transport: "websocket",
      vision: false,
    })
    await collectStreamChunks(response as AsyncIterable<unknown>)

    const sent = JSON.parse(
      MockWebSocket.instances[0]?.sent[0] ?? "",
    ) as ResponsesPayload
    expect(sent.include).toEqual([
      "reasoning.encrypted_content",
      "output.encrypted_content",
    ])
    expect(payload.include).toEqual(sent.include)
  },
)

test("Responses websocket removes output token replay include for configured models", async () => {
  getConfig().noEncryptedOutputModels = ["gpt-6-astra"]
  const payload: ResponsesPayload = {
    include: ["reasoning.encrypted_content", "output.encrypted_content"],
    input: "hello",
    model: "gpt-6-astra",
    stream: true,
  }

  const response = await createResponses(payload, {
    initiator: "user",
    requestId: "request-output-replay",
    transport: "websocket",
    vision: false,
  })
  await collectStreamChunks(response as AsyncIterable<unknown>)

  const sent = JSON.parse(MockWebSocket.instances[0]?.sent[0] ?? "") as {
    include?: Array<string>
    type?: string
  }
  expect(sent.type).toBe("response.create")
  expect(sent.include).toEqual(["reasoning.encrypted_content"])
  expect(payload.include).toEqual([
    "reasoning.encrypted_content",
    "output.encrypted_content",
  ])
})

test("Responses websocket omits include when only disabled output token replay is requested", async () => {
  getConfig().noEncryptedOutputModels = ["gpt-6-astra"]
  const payload: ResponsesPayload = {
    include: ["output.encrypted_content"],
    input: "hello",
    model: "gpt-6-astra",
    stream: true,
  }

  const response = await createResponses(payload, {
    initiator: "user",
    requestId: "request-output-replay-only",
    transport: "websocket",
    vision: false,
  })
  await collectStreamChunks(response as AsyncIterable<unknown>)

  const sent = JSON.parse(
    MockWebSocket.instances[0]?.sent[0] ?? "",
  ) as ResponsesPayload
  expect(sent).not.toHaveProperty("include")
  expect(payload.include).toEqual(["output.encrypted_content"])
})

test("Responses websocket pool reuses the same connection for matching pool keys", async () => {
  await collectResponsesStream("request-1")
  await collectResponsesStream("request-1")

  expect(MockWebSocket.instances).toHaveLength(1)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(2)
})

test("Responses websocket discards a connection after a server error event", async () => {
  MockWebSocket.autoComplete = false
  const chunksPromise = collectStreamChunks(
    await startResponsesStream("request-error"),
  )
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  MockWebSocket.instances[0]?.emitMessage(
    JSON.stringify({
      error: {
        code: "invalid_request_body",
        message:
          "Encrypted function output content could not be decrypted or decoded.",
      },
      type: "error",
    }),
  )

  const chunks = await chunksPromise
  expect(chunks.map((chunk) => chunk.event)).toEqual(["error"])
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED)

  await expectNextRequestUsesNewConnection("request-error")
})

test("Responses websocket discards a connection after a response.failed event", async () => {
  MockWebSocket.autoComplete = false
  const chunksPromise = collectStreamChunks(
    await startResponsesStream("request-failed"),
  )
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const failedResponse = {
    ...createResponsesResult("gpt-test", "resp-failed"),
    status: "failed",
  }
  MockWebSocket.instances[0]?.emitMessage(
    JSON.stringify({
      response: { ...failedResponse, status: "in_progress" },
      sequence_number: 0,
      type: "response.created",
    }),
  )
  MockWebSocket.instances[0]?.emitMessage(
    JSON.stringify({
      response: failedResponse,
      sequence_number: 1,
      type: "response.failed",
    }),
  )

  const chunks = await chunksPromise
  expect(chunks.map((chunk) => chunk.event)).toEqual([
    "response.created",
    "response.failed",
  ])
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED)

  await expectNextRequestUsesNewConnection("request-failed")
})

test("Responses websocket keeps a connection pooled after response.incomplete", async () => {
  MockWebSocket.autoComplete = false
  const chunksPromise = collectStreamChunks(
    await startResponsesStream("request-incomplete"),
  )
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  MockWebSocket.instances[0]?.emitMessage(
    JSON.stringify({
      response: {
        ...createResponsesResult("gpt-test", "resp-incomplete"),
        incomplete_details: { reason: "max_output_tokens" },
        status: "incomplete",
      },
      sequence_number: 1,
      type: "response.incomplete",
    }),
  )

  const chunks = await chunksPromise
  expect(chunks.map((chunk) => chunk.event)).toEqual(["response.incomplete"])
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN)

  const nextRequest = collectResponsesStream("request-incomplete")
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 2)
  MockWebSocket.instances[0]?.completeLatestResponse()
  await nextRequest

  expect(MockWebSocket.instances).toHaveLength(1)
})

test("Responses stream terminal disposition only reuses successful terminal events", () => {
  const dispositionOf = (data?: string) =>
    getResponsesStreamTerminalDisposition({ data })

  expect(dispositionOf()).toBe("continue")
  expect(dispositionOf("[DONE]")).toBe("continue")
  expect(dispositionOf("not json")).toBe("continue")
  expect(dispositionOf('{"type":"response.created"}')).toBe("continue")
  expect(dispositionOf('{"type":"response.output_text.delta"}')).toBe(
    "continue",
  )
  expect(dispositionOf('{"type":"response.completed"}')).toBe("reuse")
  expect(dispositionOf('{"type":"response.incomplete"}')).toBe("reuse")
  expect(dispositionOf('{"type":"response.failed"}')).toBe("discard")
  expect(dispositionOf('{"type":"error"}')).toBe("discard")
})

test("Responses websocket remains reusable when the consumer stops after the terminal chunk", async () => {
  const stream = createResponsesSafeStream(
    createTestPooledStream("terminal-break"),
  )
  for await (const chunk of stream) {
    expect(chunk.event).toBe("response.completed")
    break
  }

  await collectStreamChunks(createTestPooledStream("terminal-break"))

  expect(MockWebSocket.instances).toHaveLength(1)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(2)
})

test("Responses websocket does not reuse a pooled connection for an already aborted request", async () => {
  await collectStreamChunks(createTestPooledStream("already-aborted"))
  const controller = new AbortController()
  controller.abort(new Error("cancelled before start"))

  expect(
    await getRejectedError(
      collectStreamChunks(
        createTestPooledStream("already-aborted", {
          signal: controller.signal,
        }),
      ),
    ),
  ).toHaveProperty("message", "cancelled before start")
  expect(MockWebSocket.instances).toHaveLength(1)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
})

test("Responses websocket open failure includes the underlying reason", async () => {
  MockWebSocket.failOpen = true
  MockWebSocket.failOpenEvent = {
    error: new Error("tls handshake failed"),
  }

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )

  const chunks = await collectStreamChunks(response as AsyncIterable<unknown>)

  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain(
    '"message":"Failed to create responses websocket: tls handshake failed"',
  )
})

test("Responses websocket pool separates different request IDs", async () => {
  await collectResponsesStream("request-1")
  await collectResponsesStream("request-2")

  expect(MockWebSocket.instances).toHaveLength(2)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)
})

test("Responses websocket does not open until the stream is consumed", async () => {
  MockWebSocket.autoComplete = false

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )

  expect(MockWebSocket.instances).toHaveLength(0)

  const iterator = (response as AsyncIterable<unknown>)[Symbol.asyncIterator]()
  const firstChunk = iterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  expect(MockWebSocket.instances).toHaveLength(1)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await iterator.next()
})

test("Responses websocket delayed concurrent streams still use dedicated connections", async () => {
  MockWebSocket.autoComplete = false

  const firstResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )
  const secondResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )

  expect(MockWebSocket.instances).toHaveLength(0)

  const firstIterator = (firstResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const secondIterator = (secondResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const firstChunk = firstIterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const secondChunk = secondIterator.next()

  await waitFor(
    () =>
      MockWebSocket.instances.length === 2
      && MockWebSocket.instances[1]?.sent.length === 1,
  )

  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)

  MockWebSocket.instances[1]?.completeLatestResponse()
  await secondChunk
  await secondIterator.next()

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await firstIterator.next()
})

test("Responses websocket concurrent request bypasses the pool without closing the previous websocket", async () => {
  MockWebSocket.autoComplete = false

  const firstResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )
  const firstIterator = (firstResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const firstChunk = firstIterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const secondPromise = collectResponsesStream("request-1")

  await waitFor(
    () =>
      MockWebSocket.instances.length === 2
      && MockWebSocket.instances[1]?.sent.length === 1,
  )

  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)

  MockWebSocket.instances[1]?.completeLatestResponse()
  await secondPromise

  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN)

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await firstIterator.next()
})

test("Responses websocket multiple concurrent requests each use a dedicated connection", async () => {
  MockWebSocket.autoComplete = false

  const firstResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )
  const firstIterator = (firstResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const firstChunk = firstIterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const secondPromise = collectResponsesStream("request-1")
  const thirdPromise = collectResponsesStream("request-1")

  await waitFor(
    () =>
      MockWebSocket.instances.length === 3
      && MockWebSocket.instances[1]?.sent.length === 1,
  )

  expect(MockWebSocket.instances[2]?.sent).toHaveLength(1)

  MockWebSocket.instances[1]?.completeLatestResponse()
  await secondPromise

  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[2]?.sent).toHaveLength(1)

  MockWebSocket.instances[2]?.completeLatestResponse()
  await thirdPromise

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await firstIterator.next()
})

test("Responses websocket sequential request reuses the pooled connection after concurrent work completes", async () => {
  MockWebSocket.autoComplete = false

  const firstResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )
  const firstIterator = (firstResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const firstChunk = firstIterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const secondPromise = collectResponsesStream("request-1")

  await waitFor(
    () =>
      MockWebSocket.instances.length === 2
      && MockWebSocket.instances[1]?.sent.length === 1,
  )

  MockWebSocket.instances[1]?.completeLatestResponse()
  await secondPromise

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await firstIterator.next()

  const thirdPromise = collectResponsesStream("request-1")
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 2)

  expect(MockWebSocket.instances).toHaveLength(2)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)

  MockWebSocket.instances[0]?.completeLatestResponse()
  await thirdPromise
})

test("Responses websocket stream failure includes the underlying reason", async () => {
  MockWebSocket.autoComplete = false

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  MockWebSocket.instances[0]?.emitError({
    error: new Error("socket hang up"),
  })

  const chunks = await chunksPromise

  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain(
    '"message":"Upstream connection lost, Responses websocket stream error: socket hang up"',
  )
})

test("Responses websocket emits an error event when the websocket closes without a terminal response", async () => {
  MockWebSocket.autoComplete = false

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  MockWebSocket.instances[0]?.close()

  const chunks = await chunksPromise

  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain(
    '"message":"Responses websocket ended without a terminal response, retry your request."',
  )
})

test("Responses websocket passes HTTPS proxy env to Bun websocket init", async () => {
  const proxyEnv = clearProxyEnv()
  process.env.HTTPS_PROXY = "http://127.0.0.1:8080"

  try {
    await collectResponsesStream("proxy-request")

    expect(MockWebSocket.instances[0]?.init.proxy).toBe("http://127.0.0.1:8080")
  } finally {
    restoreProxyEnv(proxyEnv)
  }
})

test("Responses websocket honors NO_PROXY when resolving Bun websocket proxy", async () => {
  const proxyEnv = clearProxyEnv()
  process.env.HTTPS_PROXY = "http://127.0.0.1:8080"
  process.env.NO_PROXY = "api.githubcopilot.com"

  try {
    await collectResponsesStream("no-proxy-request")

    expect(MockWebSocket.instances[0]?.init.proxy).toBeUndefined()
  } finally {
    restoreProxyEnv(proxyEnv)
  }
})

test("Responses websocket opening has a real deadline", async () => {
  MockWebSocket.neverOpen = true
  const stream = createTestPooledStream("never-opens", {
    openTimeoutMs: 5,
  })

  expect(await getRejectedError(collectStreamChunks(stream))).toBeInstanceOf(
    ResponsesWebSocketOpenTimeoutError,
  )
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED)
})

test("Responses websocket can open just before its deadline", async () => {
  MockWebSocket.openDelayMs = 5
  const stream = createTestPooledStream("opens-in-time", {
    openTimeoutMs: 25,
  })

  const chunksPromise = collectStreamChunks(stream)
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  MockWebSocket.instances[0]?.completeLatestResponse()

  const chunks = await chunksPromise
  expect(chunks).toHaveLength(1)
})

test("Responses websocket active streams time out independently", async () => {
  MockWebSocket.autoComplete = false
  const stalled = createTestPooledStream("stalled", {
    streamInactivityTimeoutMs: 5,
  })
  const healthy = createTestPooledStream("healthy", {
    streamInactivityTimeoutMs: 100,
  })
  const stalledResult = collectStreamChunks(stalled)
  const healthyResult = collectStreamChunks(healthy)

  await waitFor(
    () =>
      MockWebSocket.instances.length === 2
      && MockWebSocket.instances.every(
        (websocket) => websocket.sent.length > 0,
      ),
  )
  MockWebSocket.instances[1]?.completeLatestResponse()

  expect(await getRejectedError(stalledResult)).toBeInstanceOf(
    ResponsesWebSocketInactivityTimeoutError,
  )
  expect(await healthyResult).toHaveLength(1)
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED)
  expect(MockWebSocket.instances[1]?.readyState).toBe(MockWebSocket.OPEN)
})

test("Responses websocket messages reset the active-stream deadline", async () => {
  MockWebSocket.autoComplete = false
  const chunksPromise = collectStreamChunks(
    createTestPooledStream("periodic", { streamInactivityTimeoutMs: 15 }),
  )
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  MockWebSocket.instances[0]?.emitMessage(
    '{"type":"response.output_text.delta"}',
  )
  await delay(8)
  MockWebSocket.instances[0]?.emitMessage(
    '{"type":"response.output_text.delta"}',
  )
  await delay(8)
  MockWebSocket.instances[0]?.completeLatestResponse()

  expect(await chunksPromise).toHaveLength(3)
})

test("Responses websocket terminal events clear active timers", async () => {
  MockWebSocket.autoComplete = false
  const chunksPromise = collectStreamChunks(
    createTestPooledStream("terminal-clears", {
      streamInactivityTimeoutMs: 5,
    }),
  )
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  MockWebSocket.instances[0]?.completeLatestResponse()

  expect(await chunksPromise).toHaveLength(1)
  await delay(10)
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN)
})

test("Responses websocket late idle events invalidate pooled connections", async () => {
  await collectStreamChunks(createTestPooledStream("late-event"))
  expect(MockWebSocket.instances).toHaveLength(1)
  expect(MockWebSocket.instances[0]?.listenerCount("message")).toBe(1)

  MockWebSocket.instances[0]?.emitMessage(
    '{"type":"response.output_text.delta"}',
  )
  await Promise.resolve()
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED)

  await collectStreamChunks(createTestPooledStream("late-event"))
  expect(MockWebSocket.instances).toHaveLength(2)
})

test("Responses websocket cancellation is quiet when wrapped as a Responses stream", async () => {
  MockWebSocket.autoComplete = false
  const controller = new AbortController()
  const source = createTestPooledStream("cancelled", {
    signal: controller.signal,
  })
  const chunksPromise = collectStreamChunks(
    createResponsesSafeStream(source, { signal: controller.signal }),
  )
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  controller.abort()

  expect(await chunksPromise).toEqual([])
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED)
})

test("Responses websocket cancellation while connecting closes the socket", async () => {
  MockWebSocket.neverOpen = true
  const controller = new AbortController()
  const chunksPromise = collectStreamChunks(
    createResponsesSafeStream(
      createTestPooledStream("cancel-connect", {
        signal: controller.signal,
      }),
      { signal: controller.signal },
    ),
  )
  await waitFor(() => MockWebSocket.instances.length === 1)

  controller.abort()

  expect(await chunksPromise).toEqual([])
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED)
})

test("Responses websocket buffer tracks bytes, binary data, and dequeue order", async () => {
  const buffer = new WebSocketMessageBuffer(8, 4)
  const binary = new TextEncoder().encode("bc")

  expect(buffer.enqueue("中文")).toBe(true)
  expect(buffer.enqueue(binary)).toBe(true)
  expect(buffer.bufferedBytes).toBe(8)
  expect(buffer.bufferedMessages).toBe(2)
  expect(buffer.enqueue("x")).toBe(false)
  expect(await buffer.dequeue()).toBe("中文")
  expect(buffer.bufferedBytes).toBe(2)
  expect(buffer.enqueue({ toString: () => "😀" })).toBe(true)
  expect(buffer.bufferedBytes).toBe(6)
  expect(await buffer.dequeue()).toBe("bc")
  expect(await buffer.dequeue()).toBe("😀")
  expect(buffer.bufferedBytes).toBe(0)
  expect(buffer.bufferedMessages).toBe(0)
})

test("Responses websocket buffer overflow emits one error and invalidates the socket", async () => {
  MockWebSocket.autoComplete = false
  const source = createTestPooledStream("overflow", {
    maxBufferedBytes: 8,
    maxBufferedMessages: 2,
  })
  const chunksPromise = collectStreamChunks(createResponsesSafeStream(source))
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  MockWebSocket.instances[0]?.emitMessage("1234")
  MockWebSocket.instances[0]?.emitMessage("5678")
  MockWebSocket.instances[0]?.emitMessage("overflow")

  const chunks = await chunksPromise
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain("websocket buffer exceeded")
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED)

  const nextChunksPromise = collectStreamChunks(
    createTestPooledStream("overflow"),
  )
  await waitFor(() => MockWebSocket.instances[1]?.sent.length === 1)
  MockWebSocket.instances[1]?.completeLatestResponse()
  await nextChunksPromise
  expect(MockWebSocket.instances).toHaveLength(2)
})

const createTestPooledStream = (
  poolKey: string,
  overrides: {
    maxBufferedBytes?: number
    maxBufferedMessages?: number
    openTimeoutMs?: number
    signal?: AbortSignal
    streamInactivityTimeoutMs?: number
  } = {},
): AsyncIterable<{ data?: string; event?: string }> =>
  createPooledWebSocketStream(
    {
      headers: {},
      payload: { model: "gpt-test" },
      poolKey: `test-${poolKey}`,
      signal: overrides.signal,
      url: "wss://api.githubcopilot.com/responses",
    },
    {
      createChunk: (data) => {
        const parsed = JSON.parse(data) as { type?: string }
        return { data, event: parsed.type }
      },
      getTerminalDisposition: (chunk) =>
        chunk.event === "response.completed" ? "reuse" : "continue",
      maxBufferedBytes: overrides.maxBufferedBytes ?? 1024,
      maxBufferedMessages: overrides.maxBufferedMessages ?? 32,
      openErrorMessage: "open failed",
      openTimeoutMs: overrides.openTimeoutMs ?? 100,
      poolIdleTimeoutMs: 1000,
      streamErrorMessage: "stream failed",
      streamInactivityTimeoutMs: overrides.streamInactivityTimeoutMs ?? 100,
      terminalChunkMissingMessage: "terminal missing",
    },
  )

const delay = async (milliseconds: number): Promise<void> =>
  await new Promise<void>((resolve) => {
    originalSetTimeout(resolve, milliseconds)
  })

const getRejectedError = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error("Expected promise to reject")
}

const startResponsesStream = async (
  requestId: string,
): Promise<AsyncIterable<unknown>> =>
  (await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId,
      transport: "websocket",
      vision: false,
    },
  )) as AsyncIterable<unknown>

const collectResponsesStream = async (requestId: string): Promise<void> => {
  for await (const _chunk of await startResponsesStream(requestId)) {
    // consume stream
  }
}

const expectNextRequestUsesNewConnection = async (
  requestId: string,
): Promise<void> => {
  const nextRequest = collectResponsesStream(requestId)
  await waitFor(() => MockWebSocket.instances[1]?.sent.length === 1)
  MockWebSocket.instances[1]?.completeLatestResponse()
  await nextRequest

  expect(MockWebSocket.instances).toHaveLength(2)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
}

const collectStreamChunks = async (
  stream: AsyncIterable<unknown>,
): Promise<Array<{ data?: string; event?: string; id?: string | number }>> => {
  const chunks: Array<{ data?: string; event?: string; id?: string | number }> =
    []

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

const clearProxyEnv = (): Map<ProxyEnvKey, string | undefined> => {
  const originalValues = new Map<ProxyEnvKey, string | undefined>()

  for (const key of proxyEnvKeys) {
    originalValues.set(key, process.env[key])
    delete process.env[key]
  }

  return originalValues
}

const restoreProxyEnv = (
  originalValues: Map<ProxyEnvKey, string | undefined>,
): void => {
  for (const key of proxyEnvKeys) {
    const value = originalValues.get(key)
    if (value === undefined) {
      delete process.env[key]
      continue
    }

    process.env[key] = value
  }
}

const continuationRequest = (
  socketIndex: number,
  requestIndex: number,
): ResponsesPayload =>
  JSON.parse(
    MockWebSocket.instances[socketIndex].sent[requestIndex],
  ) as ResponsesPayload

const withAffinity = <T>(affinity: string, callback: () => T): T =>
  requestContext.run(
    {
      traceId: "continuation",
      startTime: Date.now(),
      userAgent: "claude-code",
      rootSessionId: "shared-root",
      sessionAffinity: affinity,
      parentSessionId: undefined,
    },
    callback,
  )
const continuationInput = [
  { type: "message", role: "user", content: "hello" },
] as const
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
const continuationHistory = () => [
  ...continuationInput,
  ...continuationOutput,
  ...continuationInput,
]
const getContinuationRequestId = () =>
  requestContext.getStore()?.sessionAffinity ?? "continuation"
const sendContinuationTurn = async (
  input: ResponsesPayload["input"],
  clientSignal = new AbortController().signal,
) =>
  collectStreamChunks(
    (await createResponses(
      { model: "gpt-continuation", stream: true, input },
      {
        requestId: getContinuationRequestId(),
        initiator: "user",
        transport: "websocket",
        vision: false,
        clientSignal,
      },
    )) as AsyncIterable<unknown>,
  )

test("Copilot websocket continues an existing stable pool key and isolates agents", async () => {
  await withAffinity("agent-a", async () => {
    await sendContinuationTurn([...continuationInput])
    await sendContinuationTurn(continuationHistory())
  })
  expect(MockWebSocket.instances).toHaveLength(1)
  expect(continuationRequest(0, 1)).toMatchObject({
    previous_response_id: "resp-1",
    input: [...continuationInput],
  })
  await withAffinity("agent-b", () =>
    sendContinuationTurn(continuationHistory()),
  )
  expect(MockWebSocket.instances).toHaveLength(2)
  expect(continuationRequest(1, 0).previous_response_id).toBeUndefined()
})

test.each([
  { code: "previous_response_not_found" },
  { code: "unsupported_parameter", param: "previous_response_id" },
  { code: "unknown_parameter", param: "previous_response_id" },
  { code: "invalid_request_body", param: "previous_response_id" },
])(
  "retries a rejected automatic continuation once with full input (%j)",
  async (error) => {
    await withAffinity("retry", async () => {
      await sendContinuationTurn([...continuationInput])
      MockWebSocket.continuationError = error
      const chunks = await sendContinuationTurn(continuationHistory())
      expect(chunks.some((chunk) => chunk.event === "error")).toBe(false)
    })
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(continuationRequest(0, 1).previous_response_id).toBe("resp-1")
    expect(continuationRequest(1, 0)).toMatchObject({
      input: continuationHistory(),
    })
    expect(continuationRequest(1, 0).previous_response_id).toBeUndefined()
  },
)

test.each(["response-started", "other-error"])(
  "does not replay a continuation after %s",
  async (mode) => {
    await withAffinity("no-retry", async () => {
      await sendContinuationTurn([...continuationInput])
      MockWebSocket.errorAfterCreated = mode === "response-started"
      MockWebSocket.continuationError = {
        code:
          mode === "other-error" ? "server_error" : (
            "previous_response_not_found"
          ),
      }
      const chunks = await sendContinuationTurn(continuationHistory())
      expect(chunks.some((chunk) => chunk.event === "error")).toBe(true)
    })
    expect(MockWebSocket.instances).toHaveLength(1)
  },
)

test("reconnected sockets send full history", async () => {
  await withAffinity("reconnect", async () => {
    await sendContinuationTurn([...continuationInput])
    MockWebSocket.instances[0].close()
    await sendContinuationTurn(continuationHistory())
  })
  expect(MockWebSocket.instances).toHaveLength(2)
  expect(continuationRequest(1, 0).previous_response_id).toBeUndefined()
})

test("HTTP requests keep full input even when the websocket has a continuation", async () => {
  const fetchBefore = globalThis.fetch
  try {
    await withAffinity("http", async () => {
      await sendContinuationTurn([...continuationInput])
      let body: ResponsesPayload | undefined
      globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as ResponsesPayload
        return Promise.resolve(
          Response.json(createResponsesResult("gpt-continuation")),
        )
      }) as typeof fetch
      await createResponses(
        {
          model: "gpt-continuation",
          input: continuationHistory(),
        },
        {
          requestId: "http",
          initiator: "user",
          transport: "http",
          vision: false,
        },
      )
      expect(body?.previous_response_id).toBeUndefined()
      expect(body?.input).toEqual(continuationHistory())
    })
  } finally {
    globalThis.fetch = fetchBefore
  }
})

const interruptedResponseId = "resp-interrupted"
const interruptAcknowledgement = {
  type: "response.interrupt.accepted",
  response_id: interruptedResponseId,
}
const interruptedTerminal = {
  type: "response.incomplete",
  response: {
    ...createResponsesResult("gpt-continuation", interruptedResponseId),
    status: "incomplete",
    incomplete_details: { reason: "interrupted" },
  },
}
const emitInterruptibleResponseCreated = (socket: MockWebSocket) => {
  socket.emitMessage(
    JSON.stringify({
      type: "response.created",
      response: { id: interruptedResponseId },
    }),
  )
}

const startInterruptibleTurn = async () => {
  await sendContinuationTurn([...continuationInput])
  MockWebSocket.autoComplete = false
  const controller = new AbortController()
  const socket = MockWebSocket.instances[0]
  const input = continuationHistory()
  const stream = sendContinuationTurn(input, controller.signal)
  await waitFor(() => socket.sent.length === 2)
  expect(continuationRequest(0, 1).previous_response_id).toBe("resp-1")
  return { controller, socket, input, stream }
}

test.each(["acknowledgement-first", "terminal-first"] as const)(
  "interrupts on the existing socket and resumes after both events (%s)",
  async (order) => {
    await withAffinity(`interrupt-${order}`, async () => {
      const { controller, socket, input, stream } =
        await startInterruptibleTurn()
      if (order === "acknowledgement-first") {
        emitInterruptibleResponseCreated(socket)
        await delay(0)
      }
      controller.abort()
      const followup = { ...continuationInput[0], content: "follow-up" }
      const resent = sendContinuationTurn([...input, followup])
      if (order === "terminal-first") {
        await delay(0)
        expect(socket.sent).toHaveLength(2)
        expect(MockWebSocket.instances).toHaveLength(1)
        emitInterruptibleResponseCreated(socket)
      }
      await waitFor(() => socket.sent.length === 3)
      expect(JSON.parse(socket.sent[2])).toEqual({
        type: "response.interrupt",
        response_id: interruptedResponseId,
        mode: "discard_partial_items",
      })

      const [first, second] =
        order === "acknowledgement-first" ?
          [interruptAcknowledgement, interruptedTerminal]
        : [interruptedTerminal, interruptAcknowledgement]
      socket.emitMessage(JSON.stringify(first))
      await delay(0)
      expect(socket.sent).toHaveLength(3)
      expect(MockWebSocket.instances).toHaveLength(1)
      socket.emitMessage(JSON.stringify(second))

      await waitFor(() => socket.sent.length === 4)
      expect(continuationRequest(0, 3)).toMatchObject({
        previous_response_id: "resp-1",
        input: [...continuationInput, followup],
      })
      socket.completeLatestResponse()
      expect((await resent).at(-1)?.data).toContain('"id":"resp-4"')
      expect((await stream).map((chunk) => chunk.event)).toEqual([
        "response.created",
        "response.incomplete",
      ])
      expect(MockWebSocket.instances).toHaveLength(1)
    })
  },
)

test.each(["rejected", "wrong-id", "timeout", "closed", "missing-id"] as const)(
  "falls back to full input when the interrupt cannot release the socket (%s)",
  async (mode) => {
    await withAffinity(`interrupt-fallback-${mode}`, async () => {
      const { controller, socket, input, stream } =
        await startInterruptibleTurn()
      if (mode !== "missing-id") emitInterruptibleResponseCreated(socket)
      controller.abort()
      if (mode !== "missing-id") await waitFor(() => socket.sent.length === 3)
      MockWebSocket.autoComplete = true
      const resent = sendContinuationTurn(input)
      await delay(0)
      expect(MockWebSocket.instances).toHaveLength(1)

      if (mode === "closed") socket.close()
      if (mode === "rejected")
        socket.emitMessage(
          JSON.stringify({
            ...interruptAcknowledgement,
            type: "response.interrupt.failed",
          }),
        )
      if (mode === "wrong-id")
        socket.emitMessage(
          JSON.stringify({
            ...interruptAcknowledgement,
            response_id: "resp-other",
          }),
        )
      if (mode === "timeout")
        socket.emitMessage(JSON.stringify(interruptAcknowledgement))

      await resent
      await stream
      expect(socket.readyState).toBe(MockWebSocket.CLOSED)
      expect(socket.sent).toHaveLength(mode === "missing-id" ? 2 : 3)
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(continuationRequest(1, 0).previous_response_id).toBeUndefined()
      expect(continuationRequest(1, 0).input).toEqual(input)
    })
  },
)

test("a client that cancels while waiting for interruption sends no response", async () => {
  await withAffinity("cancel-interrupt-waiter", async () => {
    const { controller, socket, input, stream } = await startInterruptibleTurn()
    emitInterruptibleResponseCreated(socket)
    controller.abort()
    await waitFor(() => socket.sent.length === 3)

    const waiter = new AbortController()
    const waiting = sendContinuationTurn(input, waiter.signal)
    await delay(0)
    waiter.abort()
    expect(await waiting).toEqual([])
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(socket.sent).toHaveLength(3)
    socket.emitMessage(JSON.stringify(interruptAcknowledgement))
    socket.emitMessage(JSON.stringify(interruptedTerminal))
    await stream
  })
})

test("retries full input if the last completed ID is unavailable after interruption", async () => {
  await withAffinity("interrupt-continuation-miss", async () => {
    const { controller, socket, input, stream } = await startInterruptibleTurn()
    emitInterruptibleResponseCreated(socket)
    controller.abort()
    await waitFor(() => socket.sent.length === 3)

    MockWebSocket.continuationError = { code: "previous_response_not_found" }
    MockWebSocket.autoComplete = true
    const resent = sendContinuationTurn(input)
    await delay(0)
    expect(MockWebSocket.instances).toHaveLength(1)
    socket.emitMessage(JSON.stringify(interruptAcknowledgement))
    socket.emitMessage(JSON.stringify(interruptedTerminal))

    expect((await resent).some((chunk) => chunk.event === "error")).toBe(false)
    await stream
    expect(continuationRequest(0, 3).previous_response_id).toBe("resp-1")
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(continuationRequest(1, 0).previous_response_id).toBeUndefined()
    expect(continuationRequest(1, 0).input).toEqual(input)
  })
})
