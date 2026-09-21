import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"

const actualConfigModule = await import("~/lib/config")
const actualTokenUsageModule = await import("~/lib/token-usage")

let providerConfig: ResolvedProviderConfig | null = null

const noopTokenUsageRecorder = () => {}

const createNoopProviderTokenUsageRecorder = () => noopTokenUsageRecorder

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: () => providerConfig,
}))

await mock.module("~/lib/token-usage", () => ({
  ...actualTokenUsageModule,
  createProviderTokenUsageRecorder: createNoopProviderTokenUsageRecorder,
}))

const { providerMessageRoutes } = await import(
  "~/routes/provider/messages/route"
)

const originalFetch = globalThis.fetch

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "mai-provider",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              reasoning_content: "thinking text",
              content: "answer text",
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 2,
          total_tokens: 10,
          prompt_tokens_details: {
            cache_creation_input_tokens: 2,
            cached_tokens: 1,
          },
        },
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    ),
  ),
)

const createApp = () => {
  const app = new Hono()
  app.route("/:provider/v1/messages", providerMessageRoutes)
  return app
}

const createSseStreamResponse = (chunks: Array<Record<string, unknown>>) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
          )
        }
        // The upstream connection drops here: no [DONE] sentinel.
        controller.close()
      },
    }),
    {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  )

const parseSseData = (text: string): Array<Record<string, unknown>> =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(
      (line) =>
        JSON.parse(line.slice("data: ".length)) as Record<string, unknown>,
    )

beforeEach(() => {
  providerConfig = {
    name: "dashscope",
    type: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    apiKey: "provider-key",
    authType: "authorization",
    models: {
      "mai-provider": {
        extraBody: {
          enable_thinking: true,
          preserve_thinking: true,
          temperature: 0.9,
        },
        temperature: 0.2,
        toolContentSupportType: [],
        topK: 50,
        topP: 0.8,
      },
    },
  }
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfig = null
})

describe("openai-compatible provider messages", () => {
  test("rejects a provider-scoped Claude model before forwarding", async () => {
    const response = await createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "CLAUDE-sonnet-4",
      }),
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects Claude fallback models from provider configuration", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "mai-provider": {
          extraBody: {
            models: ["mai-provider", "anthropic/claude-sonnet-4"],
          },
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const response = await createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects Claude fallback models on native provider forwarding", async () => {
    providerConfig = {
      ...providerConfig,
      type: "anthropic",
      models: {
        "mai-provider": {
          extraBody: {
            models: ["mai-provider", "claude-sonnet-4"],
          },
        },
      },
    } as ResolvedProviderConfig

    const response = await createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects runtime Claude fallback models before forwarding", async () => {
    const response = await createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
        models: ["mai-provider", "claude-opus-4"],
      }),
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("merges message-level system prompts before OpenAI-compatible translation", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "mai-provider": {
          contextCache: false,
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          { role: "user", content: "hello" },
          { role: "system", content: "follow the repo style" },
          { role: "assistant", content: "working on it" },
          { role: "system", content: "keep answers short" },
        ],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }

    expect(body.messages).toEqual([
      {
        role: "user",
        content:
          "<system-reminder>\nfollow the repo style\n</system-reminder>\n\nhello",
      },
      {
        role: "assistant",
        content: "working on it",
      },
    ])
  })

  test("translates Anthropic messages to OpenAI chat completions", async () => {
    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
        enable_thinking: false,
        temperature: 0.4,
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    )
    expect((init as RequestInit).headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
    })

    const body = JSON.parse((init as RequestInit).body as string) as Record<
      string,
      unknown
    >
    expect(body).toMatchObject({
      enable_thinking: false,
      max_completion_tokens: 128,
      model: "mai-provider",
      preserve_thinking: true,
      temperature: 0.4,
      top_k: 50,
      top_p: 0.8,
    })
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hello",
            cache_control: {
              type: "ephemeral",
            },
          },
        ],
      },
    ])
    expect(body).not.toHaveProperty("stream_options")

    const json = (await response.json()) as Record<string, unknown>
    expect(json).toMatchObject({
      model: "mai-provider",
      role: "assistant",
      stop_reason: "end_turn",
      usage: {
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 1,
        input_tokens: 5,
        output_tokens: 2,
      },
    })
    expect(json.content).toEqual([
      {
        type: "thinking",
        thinking: "thinking text",
        signature: "",
      },
      {
        type: "text",
        text: "answer text",
      },
    ])
  })

  test("adds stream_options include_usage for OpenAI-compatible streams", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "mai-provider": {
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({
      include_usage: true,
    })
  })

  test("emits an Anthropic error event when the stream breaks during thinking output", async () => {
    const thinkingChunk = {
      id: "chatcmpl-thinking-cut",
      object: "chat.completion.chunk",
      created: 0,
      model: "mai-provider",
      choices: [
        {
          index: 0,
          delta: { reasoning_content: "partial thought" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(createSseStreamResponse([thinkingChunk])),
    )

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const events = parseSseData(await response.text())
    const eventTypes = events.map((event) => event.type)

    expect(eventTypes).toContain("message_start")
    expect(eventTypes).toContain("content_block_delta")
    expect(eventTypes).not.toContain("message_stop")
    expect(events.at(-1)).toEqual({
      type: "error",
      error: {
        message:
          "An unexpected error occurred during streaming, retry your request.",
        type: "api_error",
      },
    })
  })

  test("emits an Anthropic error event when the upstream stream fails", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("upstream connection reset"))
            },
          }),
          {
            headers: { "content-type": "text/event-stream; charset=utf-8" },
          },
        ),
      ),
    )

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const events = parseSseData(await response.text())

    expect(events).toEqual([
      {
        type: "error",
        error: {
          message:
            "An unexpected error occurred during streaming, retry your request.",
          type: "api_error",
        },
      },
    ])
  })

  test("allows extraBody to disable parallel tool calls", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "mai-provider": {
          extraBody: {
            parallel_tool_calls: false,
          },
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.parallel_tool_calls).toBe(false)
  })

  test("maps Anthropic thinking budget to OpenAI-compatible thinking_budget", async () => {
    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.thinking_budget).toBe(4096)
    expect(body).not.toHaveProperty("thinking")
  })

  test("forces thinking_budget from extraBody over request thinking budget", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "mai-provider": {
          extraBody: {
            thinking_budget: 8192,
          },
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.thinking_budget).toBe(8192)
  })
})

describe("openai-compatible provider context cache", () => {
  test("marks first system and last non-system message for OpenAI-compatible context cache", async () => {
    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        system: "system prompt",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "first answer" },
          { role: "user", content: "second" },
          { role: "assistant", content: "second answer" },
          { role: "user", content: "latest" },
        ],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    const markedMessages = body.messages.filter(
      (message) =>
        Array.isArray(message.content)
        && message.content.some(
          (part) =>
            typeof part === "object"
            && part !== null
            && "cache_control" in part,
        ),
    )

    expect(markedMessages).toHaveLength(2)
    expect(body.messages[0]).toEqual({
      role: "system",
      content: [
        {
          type: "text",
          text: "system prompt",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
    expect(body.messages[1]).toEqual({
      role: "user",
      content: "first",
    })
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: "first answer",
    })
    expect(body.messages[3]).toEqual({
      role: "user",
      content: "second",
    })
    expect(body.messages[4]).toEqual({
      role: "assistant",
      content: "second answer",
    })
    expect(body.messages[5]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "latest",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })

  test("allows disabling OpenAI-compatible context cache per model", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "mai-provider": {
          contextCache: false,
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        system: "system prompt",
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages).toEqual([
      {
        role: "system",
        content: "system prompt",
      },
      {
        role: "user",
        content: "hello",
      },
    ])
  })
})

describe("openai-compatible provider message content", () => {
  test("sends assistant thinking history as reasoning_content", async () => {
    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: "first",
          },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "empty signature thinking",
                signature: "",
              },
              {
                type: "text",
                text: "previous answer",
              },
            ],
          },
          {
            role: "user",
            content: "continue",
          },
        ],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[1]).toMatchObject({
      content: [
        {
          type: "text",
          text: "previous answer",
        },
      ],
      reasoning_content: "empty signature thinking",
      role: "assistant",
    })
    expect(body.messages[1]).not.toHaveProperty("reasoning_text")
    expect(body.messages[1]).not.toHaveProperty("reasoning_opaque")
    expect(body.messages[1]).not.toHaveProperty("reasoning")
  })
})

describe("opencode-go reasoning compatibility", () => {
  const useOpencodeGoProvider = () => {
    providerConfig = {
      name: "opencode-go",
      type: "openai-compatible",
      baseUrl: "https://opencode.ai/zen/go",
      apiKey: "provider-key",
      authType: "authorization",
      models: {
        "mai-reasoning": {
          reasoningField: "reasoning",
          toolContentSupportType: [],
        },
      },
    }
  }

  test("translates reasoning deltas to Anthropic thinking events", async () => {
    useOpencodeGoProvider()
    const reasoningChunk = {
      id: "gen-1788267775-qTbelOO6wDJXzNXu9Hej",
      object: "chat.completion.chunk",
      created: 1788267775,
      model: "mai-reasoning",
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: {
            role: "assistant",
            content: "",
            reasoning: "thinking...",
            reasoning_details: [
              {
                type: "reasoning.text",
                text: "thinking...",
                format: "unknown",
                index: 0,
              },
            ],
          },
        },
      ],
    }
    const contentChunk = {
      id: "gen-1788267775-qTbelOO6wDJXzNXu9Hej",
      object: "chat.completion.chunk",
      created: 1788267775,
      model: "mai-reasoning",
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: { content: "answer" },
        },
      ],
    }
    const doneChunk = {
      id: "gen-1788267775-qTbelOO6wDJXzNXu9Hej",
      object: "chat.completion.chunk",
      created: 1788267775,
      model: "mai-reasoning",
      choices: [{ index: 0, finish_reason: "stop", delta: {} }],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 3,
        total_tokens: 11,
      },
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        createSseStreamResponse([reasoningChunk, contentChunk, doneChunk]),
      ),
    )

    const app = createApp()
    const response = await app.request("/opencode-go/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-reasoning",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const events = parseSseData(await response.text())
    const eventTypes = events.map((event) => event.type)

    expect(eventTypes).toContain("message_start")
    expect(eventTypes).toContain("message_stop")

    const blockStarts = events.filter(
      (event) => event.type === "content_block_start",
    )
    expect(
      blockStarts.map(
        (event) => (event.content_block as Record<string, unknown>).type,
      ),
    ).toEqual(["thinking", "text"])

    const thinkingDeltas = events.filter(
      (event) =>
        event.type === "content_block_delta"
        && (event.delta as Record<string, unknown>).type === "thinking_delta",
    )
    expect(thinkingDeltas).toHaveLength(1)
    expect((thinkingDeltas[0].delta as Record<string, unknown>).thinking).toBe(
      "thinking...",
    )

    const textDeltas = events.filter(
      (event) =>
        event.type === "content_block_delta"
        && (event.delta as Record<string, unknown>).type === "text_delta",
    )
    expect(textDeltas).toHaveLength(1)
    expect((textDeltas[0].delta as Record<string, unknown>).text).toBe("answer")
  })

  test("translates non-stream reasoning message to an Anthropic thinking block", async () => {
    useOpencodeGoProvider()
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "gen-1788267775",
            object: "chat.completion",
            created: 1788267775,
            model: "mai-reasoning",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  reasoning: "thinking text",
                  content: "answer text",
                },
                finish_reason: "stop",
                logprobs: null,
              },
            ],
            usage: {
              prompt_tokens: 8,
              completion_tokens: 2,
              total_tokens: 10,
            },
          }),
          {
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      ),
    )

    const app = createApp()
    const response = await app.request("/opencode-go/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-reasoning",
      }),
    })

    expect(response.status).toBe(200)
    const json = (await response.json()) as Record<string, unknown>
    expect(json.content).toEqual([
      {
        type: "thinking",
        thinking: "thinking text",
        signature: "",
      },
      {
        type: "text",
        text: "answer text",
      },
    ])
  })

  test("sends assistant thinking history with the reasoning field", async () => {
    useOpencodeGoProvider()
    const app = createApp()
    const response = await app.request("/opencode-go/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: "first",
          },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "previous thinking",
                signature: "",
              },
              {
                type: "text",
                text: "previous answer",
              },
            ],
          },
          {
            role: "user",
            content: "continue",
          },
        ],
        model: "mai-reasoning",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[1]).toMatchObject({
      reasoning: "previous thinking",
      role: "assistant",
    })
    expect(body.messages[1]).not.toHaveProperty("reasoning_content")
    expect(body.messages[1]).not.toHaveProperty("reasoning_text")
    expect(body.messages[1]).not.toHaveProperty("reasoning_opaque")
  })

  test("omits the reasoning field for opencode-go models without the flag", async () => {
    useOpencodeGoProvider()
    const app = createApp()
    const response = await app.request("/opencode-go/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "previous thinking",
                signature: "",
              },
              {
                type: "text",
                text: "previous answer",
              },
            ],
          },
          {
            role: "user",
            content: "continue",
          },
        ],
        model: "mai-default",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[0]).toMatchObject({
      reasoning_content: "previous thinking",
      role: "assistant",
    })
    expect(body.messages[0]).not.toHaveProperty("reasoning")
  })

  test("sends the reasoning field when enabled in custom model config", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "mai-provider": {
          reasoningField: "reasoning",
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "previous thinking",
                signature: "",
              },
              {
                type: "text",
                text: "previous answer",
              },
            ],
          },
          {
            role: "user",
            content: "continue",
          },
        ],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[0]).toMatchObject({
      reasoning: "previous thinking",
      role: "assistant",
    })
    expect(body.messages[0]).not.toHaveProperty("reasoning_content")
  })
})

describe("openai-compatible provider tool array content", () => {
  test("marks string tool result content for context cache", async () => {
    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_text",
                content: "plain tool result",
              },
            ],
          },
        ],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tool_text",
      content: [
        {
          type: "text",
          text: "plain tool result",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })

  test("marks tool result array content when array tool content is enabled", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "mai-provider": {
          toolContentSupportType: ["array"],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_text",
                content: [
                  {
                    type: "text",
                    text: "first line",
                  },
                  {
                    type: "text",
                    text: "second line",
                  },
                ],
              },
            ],
          },
        ],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tool_text",
      content: [
        {
          type: "text",
          text: "first line",
        },
        {
          type: "text",
          text: "second line",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })
})

describe("openai-compatible provider PDF message content", () => {
  test("sends PDF tool results as file parts when PDF tool content is enabled", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "mai-provider": {
          supportPdf: true,
          toolContentSupportType: ["pdf"],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_pdf",
                content: [
                  {
                    type: "text",
                    text: "PDF file read: report.pdf",
                  },
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
          },
        ],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tool_pdf",
      content: [
        {
          type: "text",
          text: "PDF file read: report.pdf",
        },
        {
          type: "file",
          file: {
            file_data: "data:application/pdf;base64,pdf-data",
            filename: "report.pdf",
          },
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })

  test("moves PDF file parts to user messages when tool PDF support is missing", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "mai-provider": {
          supportPdf: true,
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_pdf",
                content: [
                  {
                    type: "text",
                    text: "PDF file read: report.pdf",
                  },
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
          },
        ],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tool_pdf",
      content: "PDF file read: report.pdf",
    })
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "Tool result for tool_pdf:",
        },
        {
          type: "text",
          text: "PDF file read: report.pdf",
        },
        {
          type: "file",
          file: {
            file_data: "data:application/pdf;base64,pdf-data",
            filename: "report.pdf",
          },
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })
})

describe("non-dashscope openai-compatible provider restrictions", () => {
  test("strips request-derived thinking_budget for non-dashscope providers", async () => {
    providerConfig = {
      ...providerConfig,
      name: "custom",
      baseUrl: "https://api.example.com/v1",
      models: {
        "mai-provider": {
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/custom/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).not.toHaveProperty("thinking_budget")
  })

  test("keeps extraBody thinking_budget for non-dashscope providers", async () => {
    providerConfig = {
      ...providerConfig,
      name: "custom",
      baseUrl: "https://api.example.com/v1",
      models: {
        "mai-provider": {
          extraBody: {
            thinking_budget: 8192,
          },
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/custom/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.thinking_budget).toBe(8192)
  })

  test("does not apply context cache for non-dashscope providers by default", async () => {
    providerConfig = {
      ...providerConfig,
      name: "custom",
      baseUrl: "https://api.example.com/v1",
      models: {
        "mai-provider": {
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/custom/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        system: "system prompt",
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    for (const message of body.messages) {
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (typeof part === "object" && part !== null) {
            expect(part).not.toHaveProperty("cache_control")
          }
        }
      }
    }
  })

  test("applies context cache for non-dashscope providers when explicitly enabled", async () => {
    providerConfig = {
      ...providerConfig,
      name: "custom",
      baseUrl: "https://api.example.com/v1",
      models: {
        "mai-provider": {
          contextCache: true,
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/custom/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        system: "system prompt",
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    const systemMessage = body.messages[0]
    expect(Array.isArray(systemMessage.content)).toBe(true)
    const systemPart = (
      systemMessage.content as Array<Record<string, unknown>>
    )[0]
    expect(systemPart.cache_control).toEqual({ type: "ephemeral" })
  })

  test("detects dashscope via aliyuncs.com in baseUrl", async () => {
    providerConfig = {
      ...providerConfig,
      name: "my-bailian",
      baseUrl: "https://bailian.aliyuncs.com/api/v1",
      models: {
        "mai-provider": {
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/my-bailian/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.thinking_budget).toBe(4096)
  })
})

describe("dashscope preserve_thinking default", () => {
  test("defaults preserve_thinking to true for dashscope when not set", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "mai-provider": {
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.preserve_thinking).toBe(true)
  })

  test("keeps explicit preserve_thinking false from extraBody", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "mai-provider": {
          extraBody: {
            preserve_thinking: false,
          },
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.preserve_thinking).toBe(false)
  })

  test("does not set preserve_thinking for non-dashscope providers", async () => {
    providerConfig = {
      ...providerConfig,
      name: "custom",
      baseUrl: "https://api.example.com/v1",
      models: {
        "mai-provider": {
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/custom/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "mai-provider",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).not.toHaveProperty("preserve_thinking")
  })
})
