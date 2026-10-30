import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import type { ChatCompletionResponse } from "~/lib/types/chat-completions"
import type { ResponsesPayload, ResponsesResult } from "~/lib/types/responses"
import { UpstreamStreamInactivityTimeoutError } from "~/lib/error"
import type { UsageTokens } from "~/lib/token-usage"

const actualConfigModule = await import("~/lib/config")
const actualTokenUsageModule = await import("~/lib/token-usage")

let providerConfig: ResolvedProviderConfig | null = null
let upstreamResponseFactory: () => Response

const recordedUsages: Array<UsageTokens> = []
const providerTokenUsageRecorder = (usage: UsageTokens): void => {
  recordedUsages.push(usage)
}
let restoreTokenUsageRecorder = () => {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: () => providerConfig,
}))

const { providerMessageRoutes } = await import(
  "~/routes/provider/messages/route"
)

const { providerMessagesHandlerDependencies } = await import(
  "~/routes/provider/messages/handler"
)

const originalFetch = globalThis.fetch
const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(upstreamResponseFactory()),
)

const createApp = () => {
  const app = new Hono()
  app.route("/:provider/v1/messages", providerMessageRoutes)
  return app
}

const createProviderConfig = (name = "openrouter"): ResolvedProviderConfig => ({
  apiKey: "provider-key",
  authType: "authorization",
  baseUrl: "https://openrouter.example/api",
  models: {
    "claude-sonnet-4": {},
  },
  name,
  type: "anthropic",
})

const createMessagesPayload = (overrides: Record<string, unknown> = {}) => ({
  max_tokens: 128,
  messages: [{ content: "hello", role: "user" }],
  model: "claude-sonnet-4",
  ...overrides,
})

const createThinkingResponse = () => ({
  content: [
    {
      thinking: "internal reasoning",
      type: "thinking",
    },
    {
      signature: "upstream-signature",
      thinking: "already signed reasoning",
      type: "thinking",
    },
    {
      text: "answer text",
      type: "text",
    },
  ],
  id: "msg_openrouter",
  model: "claude-sonnet-4",
  role: "assistant",
  stop_reason: "end_turn",
  stop_sequence: null,
  type: "message",
  usage: {
    input_tokens: 4,
    output_tokens: 3,
  },
})

const createThinkingStreamResponse = (
  signature?: string,
  cost?: number,
): Response => {
  const chunks: Array<string> = []
  const appendEvent = (event: string, data: unknown): void => {
    chunks.push(`event: ${event}`)
    chunks.push(
      `data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
    )
    chunks.push("")
  }

  appendEvent("message_start", {
    message: {
      content: [],
      id: "msg_openrouter_stream",
      model: "claude-sonnet-4",
      role: "assistant",
      stop_reason: null,
      stop_sequence: null,
      type: "message",
      usage: { input_tokens: 4, output_tokens: 0 },
    },
    type: "message_start",
  })
  appendEvent("content_block_start", {
    content_block: { thinking: "", type: "thinking" },
    index: 0,
    type: "content_block_start",
  })
  appendEvent("content_block_delta", {
    delta: { thinking: "internal reasoning", type: "thinking_delta" },
    index: 0,
    type: "content_block_delta",
  })
  if (signature !== undefined) {
    appendEvent("content_block_delta", {
      delta: { signature, type: "signature_delta" },
      index: 0,
      type: "content_block_delta",
    })
  }
  appendEvent("content_block_stop", {
    index: 0,
    type: "content_block_stop",
  })
  appendEvent("content_block_start", {
    content_block: { text: "", type: "text" },
    index: 1,
    type: "content_block_start",
  })
  appendEvent("content_block_stop", {
    index: 1,
    type: "content_block_stop",
  })
  appendEvent("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    type: "message_delta",
    usage: { output_tokens: 3, ...(cost === undefined ? {} : { cost }) },
  })
  appendEvent("message_stop", { type: "message_stop" })
  appendEvent("message_stop", "[DONE]")

  return new Response(chunks.join("\n"), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  })
}

const createFailingResponsesStream = (): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new UpstreamStreamInactivityTimeoutError(25))
      },
    }),
    {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  )

const parseStreamData = (text: string): Array<Record<string, unknown>> =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(
      (line) =>
        JSON.parse(line.slice("data: ".length)) as Record<string, unknown>,
    )

beforeEach(() => {
  const recorder = spyOn(
    actualTokenUsageModule,
    "createProviderTokenUsageRecorder",
  ).mockImplementation(() => providerTokenUsageRecorder)
  restoreTokenUsageRecorder = () => recorder.mockRestore()
  providerConfig = createProviderConfig()
  recordedUsages.length = 0
  upstreamResponseFactory = () =>
    new Response(JSON.stringify(createThinkingResponse()), {
      headers: { "content-type": "application/json" },
    })
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  restoreTokenUsageRecorder()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfig = null
})

describe("provider Messages Anthropic forwarding", () => {
  test.each(["anthropic", "openai-compatible", "openai-responses"] as const)(
    "forces low effort for Claude without tools through a %s provider",
    async (type) => {
      providerConfig = { ...createProviderConfig(), type }
      if (type === "openai-compatible") {
        upstreamResponseFactory = () =>
          Response.json({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 0,
            model: "claude-sonnet-4",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                logprobs: null,
                finish_reason: "stop",
              },
            ],
          } satisfies ChatCompletionResponse)
      } else if (type === "openai-responses") {
        upstreamResponseFactory = () =>
          Response.json({
            id: "resp-test",
            object: "response",
            created_at: 0,
            model: "claude-sonnet-4",
            output: [],
            output_text: "",
            status: "completed",
            error: null,
            incomplete_details: null,
            instructions: null,
            metadata: null,
            parallel_tool_calls: false,
            temperature: null,
            tool_choice: "auto",
            tools: [],
            top_p: null,
          } satisfies ResponsesResult)
      }
      const response = await createApp().request("/openrouter/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Claude-Code/2.1.258",
        },
        body: JSON.stringify(
          createMessagesPayload({
            tools: [],
            output_config: { effort: "max" },
          }),
        ),
      })

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const body = fetchMock.mock.calls[0][1]?.body
      expect(typeof body).toBe("string")
      const forwardedPayload: unknown = JSON.parse(body as string)
      expect(forwardedPayload).toMatchObject(
        type === "anthropic" ? { output_config: { effort: "low" } }
        : type === "openai-compatible" ? { reasoning_effort: "low" }
        : { reasoning: { effort: "low" } },
      )
    },
  )

  test.each([
    {
      userAgent: "claude-cli/2.1.258",
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
    },
    { userAgent: "curl/8.0", tools: [] },
  ])(
    "preserves max effort for provider requests with $userAgent and tools $tools",
    async ({ userAgent, tools }) => {
      const response = await createApp().request("/openrouter/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": userAgent,
        },
        body: JSON.stringify(
          createMessagesPayload({
            tools,
            output_config: { effort: "max" },
          }),
        ),
      })

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const body = fetchMock.mock.calls[0][1]?.body
      expect(typeof body).toBe("string")
      const forwardedPayload = JSON.parse(
        body as string,
      ) as AnthropicMessagesPayload
      expect(forwardedPayload.output_config?.effort).toBe("max")
    },
  )

  test.each([
    { provider: "openrouter", model: "claude-sonnet-4" },
    { provider: "anthropic", model: "claude-sonnet-4" },
    { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
    { provider: "openrouter", model: "vendor-claude-sonnet-4" },
  ])(
    "forwards a user continuation after a trailing Claude assistant message: %j",
    async ({ provider, model }) => {
      providerConfig = {
        ...createProviderConfig(provider),
        models: { [model]: {} },
      }
      const messages: AnthropicMessagesPayload["messages"] = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "partial answer" }],
        },
      ]
      const response = await createApp().request(`/${provider}/v1/messages`, {
        body: JSON.stringify(createMessagesPayload({ model, messages })),
        headers: { "content-type": "application/json" },
        method: "POST",
      })

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const body = fetchMock.mock.calls[0][1]?.body
      if (typeof body !== "string") throw new Error("Expected a JSON body")
      const forwarded = JSON.parse(body) as AnthropicMessagesPayload
      expect(forwarded.model).toBe(model)
      expect(forwarded.messages).toEqual([
        ...messages,
        {
          role: "user",
          content: [{ type: "text", text: "Please continue." }],
        },
      ])
    },
  )

  test("preserves trailing assistant messages for non-Claude provider models", async () => {
    providerConfig = {
      ...createProviderConfig(),
      models: { "gpt-5.4": { type: "anthropic" } },
    }
    const messages: AnthropicMessagesPayload["messages"] = [
      { role: "assistant", content: "partial answer" },
    ]
    const response = await createApp().request("/openrouter/v1/messages", {
      body: JSON.stringify(
        createMessagesPayload({ model: "gpt-5.4", messages }),
      ),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = fetchMock.mock.calls[0][1]?.body
    if (typeof body !== "string") throw new Error("Expected a JSON body")
    const forwarded = JSON.parse(body) as AnthropicMessagesPayload
    expect(forwarded.messages).toEqual(messages)
  })

  test("adds an empty thinking signature for OpenRouter JSON responses", async () => {
    const response = await createApp().request("/openrouter/v1/messages", {
      body: JSON.stringify(createMessagesPayload()),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      content: Array<Record<string, unknown>>
    }
    expect(json.content).toEqual([
      {
        signature: "",
        thinking: "internal reasoning",
        type: "thinking",
      },
      {
        signature: "upstream-signature",
        thinking: "already signed reasoning",
        type: "thinking",
      },
      {
        text: "answer text",
        type: "text",
      },
    ])
  })

  test("adds an empty signature_delta before an unsigned thinking block stops", async () => {
    upstreamResponseFactory = () => createThinkingStreamResponse()

    const response = await createApp().request("/openrouter/v1/messages", {
      body: JSON.stringify(createMessagesPayload({ stream: true })),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const events = parseStreamData(await response.text())
    const signatureIndex = events.findIndex(
      (event) =>
        event.type === "content_block_delta"
        && (event.delta as { type?: string } | undefined)?.type
          === "signature_delta",
    )
    const stopIndex = events.findIndex(
      (event) => event.type === "content_block_stop",
    )

    expect(signatureIndex).toBeGreaterThan(-1)
    expect(signatureIndex).toBeLessThan(stopIndex)
    expect(events[signatureIndex]).toEqual({
      delta: { signature: "", type: "signature_delta" },
      index: 0,
      type: "content_block_delta",
    })
  })

  test("preserves an existing OpenRouter streaming signature", async () => {
    upstreamResponseFactory = () => createThinkingStreamResponse("signed")

    const response = await createApp().request("/openrouter/v1/messages", {
      body: JSON.stringify(createMessagesPayload({ stream: true })),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const events = parseStreamData(await response.text())
    const signatureEvents = events.filter(
      (event) =>
        event.type === "content_block_delta"
        && (event.delta as { type?: string } | undefined)?.type
          === "signature_delta",
    )
    expect(signatureEvents).toEqual([
      {
        delta: { signature: "signed", type: "signature_delta" },
        index: 0,
        type: "content_block_delta",
      },
    ])
  })

  test("records the cost reported in an OpenRouter message delta", async () => {
    const cost = 0.0002928408
    upstreamResponseFactory = () =>
      createThinkingStreamResponse(undefined, cost)

    const response = await createApp().request("/openrouter/v1/messages", {
      body: JSON.stringify(createMessagesPayload({ stream: true })),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    await response.text()

    expect(recordedUsages).toHaveLength(1)
    expect(recordedUsages[0]).toMatchObject({
      cost,
      input_tokens: 4,
      output_tokens: 3,
    })
  })

  test("emits an Anthropic error event when the stream ends without message_stop", async () => {
    upstreamResponseFactory = () => {
      const chunks: Array<string> = []
      const appendEvent = (event: string, data: unknown): void => {
        chunks.push(`event: ${event}`)
        chunks.push(
          `data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
        )
        chunks.push("")
      }
      appendEvent("message_start", {
        message: {
          content: [],
          id: "msg_cut",
          model: "claude-sonnet-4",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 4, output_tokens: 0 },
        },
        type: "message_start",
      })
      appendEvent("content_block_delta", {
        delta: { text: "partial", type: "text_delta" },
        index: 0,
        type: "content_block_delta",
      })
      // The upstream connection drops here: no message_stop, no [DONE].
      return new Response(chunks.join("\n"), {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      })
    }

    const response = await createApp().request("/openrouter/v1/messages", {
      body: JSON.stringify(createMessagesPayload({ stream: true })),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const events = parseStreamData(await response.text())
    const eventTypes = events.map((event) => event.type)

    expect(eventTypes).toContain("message_start")
    expect(eventTypes).not.toContain("message_stop")
    expect(events.at(-1)).toEqual({
      error: {
        message:
          "An unexpected error occurred during streaming, retry your request.",
        type: "api_error",
      },
      type: "error",
    })
  })

  test("emits an Anthropic error event when the upstream connection fails", async () => {
    upstreamResponseFactory = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("upstream connection reset"))
          },
        }),
        {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        },
      )

    const response = await createApp().request("/openrouter/v1/messages", {
      body: JSON.stringify(createMessagesPayload({ stream: true })),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(parseStreamData(await response.text())).toEqual([
      {
        error: {
          message:
            "An unexpected error occurred during streaming, retry your request.",
          type: "api_error",
        },
        type: "error",
      },
    ])
  })

  test("forwards an upstream error event without appending another", async () => {
    const upstreamError = {
      error: { message: "overloaded", type: "overloaded_error" },
      type: "error",
    }
    upstreamResponseFactory = () =>
      new Response(`event: error\ndata: ${JSON.stringify(upstreamError)}\n\n`, {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      })

    const response = await createApp().request("/openrouter/v1/messages", {
      body: JSON.stringify(createMessagesPayload({ stream: true })),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(parseStreamData(await response.text())).toEqual([upstreamError])
  })

  test("does not append an error event after a normal completion", async () => {
    upstreamResponseFactory = () => createThinkingStreamResponse("signed")

    const response = await createApp().request("/openrouter/v1/messages", {
      body: JSON.stringify(createMessagesPayload({ stream: true })),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const eventTypes = parseStreamData(await response.text()).map(
      (event) => event.type,
    )

    expect(eventTypes).toContain("message_stop")
    expect(eventTypes).not.toContain("error")
  })
})

describe("provider Messages Responses forwarding", () => {
  test("preserves PDF data when xAI Messages requests use the Responses adapter", async () => {
    providerConfig = {
      ...createProviderConfig("xai"),
      type: "openai-responses",
      models: {},
    }
    upstreamResponseFactory = () =>
      Response.json({
        id: "resp-pdf-test",
        object: "response",
        created_at: 0,
        model: "grok-4.7",
        output: [],
        output_text: "",
        status: "completed",
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: null,
        parallel_tool_calls: false,
        temperature: null,
        tool_choice: "auto",
        tools: [],
        top_p: null,
      } satisfies ResponsesResult)
    const payload: AnthropicMessagesPayload = {
      model: "grok-4.7",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "pdf-data",
              },
              title: "report.pdf",
            },
          ],
        },
      ],
    }
    const response = await createApp().request("/xai/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = fetchMock.mock.calls[0][1]?.body
    if (typeof body !== "string") throw new Error("Expected a JSON body")
    const forwarded = JSON.parse(body) as ResponsesPayload
    expect(forwarded.input).toContainEqual({
      type: "message",
      role: "user",
      content: [
        {
          type: "input_file",
          file_data: "data:application/pdf;base64,pdf-data",
          filename: "report.pdf",
        },
      ],
    })
  })

  test("emits an Anthropic error event and records usage when the upstream stream fails", async () => {
    providerConfig = {
      ...createProviderConfig("responses"),
      type: "openai-responses",
    }
    upstreamResponseFactory = createFailingResponsesStream

    const response = await createApp().request("/responses/v1/messages", {
      body: JSON.stringify(createMessagesPayload({ stream: true })),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(parseStreamData(await response.text())).toEqual([
      {
        error: {
          message: "Upstream stream was inactive for 25ms",
          type: "api_error",
        },
        type: "error",
      },
    ])
    expect(recordedUsages).toEqual([{}])
  })
})

describe("provider Messages per-model type override auth", () => {
  const originalResolveProviderConfig =
    providerMessagesHandlerDependencies.resolveProviderConfig

  afterEach(() => {
    providerMessagesHandlerDependencies.resolveProviderConfig =
      originalResolveProviderConfig
  })

  const stubResolvedConfig = (config: ResolvedProviderConfig): void => {
    providerMessagesHandlerDependencies.resolveProviderConfig = () =>
      Promise.resolve(config)
  }

  const lastUpstreamHeaders = (): Record<string, string> => {
    const lastCall = fetchMock.mock.calls.at(-1) as unknown as [
      unknown,
      { headers: Record<string, string> },
    ]
    return lastCall[1].headers
  }

  test("preserves azure-entra auth when a model overrides the provider type", async () => {
    stubResolvedConfig({
      apiKey: "entra-access-token",
      authType: "azure-entra",
      baseUrl: "https://foundry.example/openai",
      models: { "claude-sonnet-4": { type: "anthropic" } },
      name: "foundry",
      type: "openai-compatible",
    })

    const response = await createApp().request("/foundry/v1/messages", {
      body: JSON.stringify(createMessagesPayload()),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const headers = lastUpstreamHeaders()
    expect(headers.authorization).toBe("Bearer entra-access-token")
    expect(headers["x-api-key"]).toBeUndefined()
  })

  test("falls back to the override type default for regular auth types", async () => {
    stubResolvedConfig({
      apiKey: "provider-key",
      authType: "authorization",
      baseUrl: "https://mixed.example",
      models: { "claude-sonnet-4": { type: "anthropic" } },
      name: "mixed",
      type: "openai-compatible",
    })

    const response = await createApp().request("/mixed/v1/messages", {
      body: JSON.stringify(createMessagesPayload()),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const headers = lastUpstreamHeaders()
    expect(headers["x-api-key"]).toBe("provider-key")
    expect(headers.authorization).toBeUndefined()
  })
})
