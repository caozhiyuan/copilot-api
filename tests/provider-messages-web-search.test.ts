import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/types/anthropic"
import type { ResponsesResult } from "~/lib/types/responses"

const actualConfigModule = await import("~/lib/config")
const actualModelsModule = await import("~/lib/models")
const actualStateModule = await import("~/lib/state")
const actualTokenModule = await import("~/lib/token")
const actualTokenUsageModule = await import("~/lib/token-usage")

let providerConfigs: Record<string, ResolvedProviderConfig> = {}
let messageApiWebSearchModel: string | undefined

const noopTokenUsageRecorder = () => {}
const findEndpointModel = mock((model: string) => ({
  id: model,
  supported_endpoints: ["/v1/messages"],
}))

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getMessageApiWebSearchModel: () => messageApiWebSearchModel,
  getProviderConfig: (name: string) => providerConfigs[name] ?? null,
  isResponsesApiWebSearchEnabled: () => true,
  isResponsesApiWebSocketEnabled: () => false,
  resolveMappedModel: (model: string) => model,
}))

await mock.module("~/lib/models", () => ({
  ...actualModelsModule,
  findEndpointModel,
}))

await mock.module("~/lib/state", () => ({
  ...actualStateModule,
  state: {
    ...actualStateModule.state,
    tokenBasedBilling: true,
    verbose: false,
  },
}))

await mock.module("~/lib/token", () => ({
  ...actualTokenModule,
  setupCodexToken: async () => {},
}))

await mock.module("~/lib/token-usage", () => ({
  ...actualTokenUsageModule,
  createProviderTokenUsageRecorder: () => noopTokenUsageRecorder,
}))

const { providerMessageRoutes } = await import(
  "~/routes/provider/messages/route"
)
const { messageRoutes } = await import("~/routes/messages/route")
const { state } = await import("~/lib/state")
const { responsesUtilsDependencies } = await import("~/routes/responses/utils")

const originalCodexAccessToken = state.codexAccessToken
const originalCodexAccountId = state.codexAccountId
const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }

const makeResponsesResult = (
  overrides: Partial<ResponsesResult> = {},
): ResponsesResult =>
  ({
    id: "resp_provider_search",
    object: "response",
    created_at: 0,
    model: "gpt-search",
    output: [
      { type: "web_search_call", action: { query: "node lts version" } },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Node.js 24 is the latest LTS.",
            annotations: [
              {
                type: "url_citation",
                url: "https://nodejs.org",
                title: "Node.js",
              },
            ],
          },
        ],
      },
    ],
    output_text: "",
    status: "completed",
    usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: null,
    tools: [],
    top_p: null,
    ...overrides,
  }) as unknown as ResponsesResult

const makePlainResponsesResult = (): ResponsesResult =>
  makeResponsesResult({
    id: "resp_provider_message",
    output: [
      {
        id: "msg-provider-message",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Hello from Codex.",
            annotations: [],
          },
        ],
      },
    ],
    output_text: "Hello from Codex.",
  })

const makeChatCompletionResponse = () => ({
  id: "chatcmpl-web-search-stripped",
  object: "chat.completion",
  created: 0,
  model: "gpt-provider",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
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
})

const makeResponsesStreamResponse = (body: ResponsesResult) => {
  let sequenceNumber = 1
  const chunks = [
    "event: response.created",
    `data: ${JSON.stringify({
      response: {
        ...body,
        output: [],
        output_text: "",
        usage: null,
      },
      sequence_number: sequenceNumber,
      type: "response.created",
    })}`,
    "",
  ]

  body.output.forEach((item, outputIndex) => {
    if (item.type === "message") {
      item.content?.forEach((content, contentIndex) => {
        if (content.type !== "output_text") {
          return
        }

        sequenceNumber += 1
        chunks.push(
          "event: response.output_text.delta",
          `data: ${JSON.stringify({
            content_index: contentIndex,
            delta: content.text,
            item_id: item.id,
            output_index: outputIndex,
            sequence_number: sequenceNumber,
            type: "response.output_text.delta",
          })}`,
          "",
        )

        sequenceNumber += 1
        chunks.push(
          "event: response.output_text.done",
          `data: ${JSON.stringify({
            content_index: contentIndex,
            item_id: item.id,
            output_index: outputIndex,
            sequence_number: sequenceNumber,
            text: content.text,
            type: "response.output_text.done",
          })}`,
          "",
        )
      })
    }

    sequenceNumber += 1
    chunks.push(
      "event: response.output_item.done",
      `data: ${JSON.stringify({
        item,
        output_index: outputIndex,
        sequence_number: sequenceNumber,
        type: "response.output_item.done",
      })}`,
      "",
    )
  })

  sequenceNumber += 1
  chunks.push(
    "event: response.completed",
    `data: ${JSON.stringify({
      response: {
        ...body,
        output: [],
        output_text: "",
      },
      sequence_number: sequenceNumber,
      type: "response.completed",
    })}`,
    "",
    "data: [DONE]",
    "",
  )

  return new Response(chunks.join("\n"), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  })
}

const originalFetch = globalThis.fetch
let responsesResultOverride: ResponsesResult | undefined
let responsesStreamFactory: ((body: ResponsesResult) => Response) | undefined

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const urlString =
    typeof url === "string" ? url
    : url instanceof URL ? url.href
    : url.url
  const requestPayload =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as {
        stream?: boolean
        tools?: Array<{ type?: unknown }>
      })
    : {}

  if (urlString.endsWith("/v1/chat/completions")) {
    return Promise.resolve(
      new Response(JSON.stringify(makeChatCompletionResponse()), {
        headers: { "content-type": "application/json" },
      }),
    )
  }

  const hasWebSearchTool = requestPayload.tools?.some(
    (tool) => tool.type === "web_search",
  )
  const body =
    responsesResultOverride
    ?? (hasWebSearchTool ? makeResponsesResult() : makePlainResponsesResult())

  if (
    (urlString.endsWith("/v1/responses")
      || urlString.endsWith("/codex/responses"))
    && requestPayload.stream === true
  ) {
    return Promise.resolve(
      responsesStreamFactory?.(body) ?? makeResponsesStreamResponse(body),
    )
  }

  return Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    }),
  )
})

const createApp = () => {
  const app = new Hono()
  app.route("/v1/messages", messageRoutes)
  app.route("/:provider/v1/messages", providerMessageRoutes)
  return app
}

const webSearchTool = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 3,
  allowed_domains: ["nodejs.org"],
  user_location: {
    type: "approximate",
    country: "US",
  },
}

const configureCodexProvider = (): void => {
  providerConfigs.codex = {
    name: "codex",
    type: "openai-responses",
    baseUrl: "https://codex.example/backend-api",
    apiKey: "unused",
    authType: "authorization",
    models: {
      "gpt-search": {
        toolContentSupportType: [],
      },
    },
  }
}

const createCodexMessagesPayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
  model: "gpt-search",
  ...overrides,
})

beforeEach(() => {
  providerConfigs = {
    search: {
      name: "search",
      type: "openai-responses",
      baseUrl: "https://provider.example",
      apiKey: "provider-key",
      authType: "authorization",
      models: {
        "gpt-search": {
          toolContentSupportType: [],
        },
      },
    },
  }
  state.codexAccessToken = "codex-token"
  state.codexAccountId = "codex-account"
  messageApiWebSearchModel = undefined
  responsesResultOverride = undefined
  responsesStreamFactory = undefined
  findEndpointModel.mockClear()
  responsesUtilsDependencies.getModelResponsesApiCompactThreshold = () =>
    undefined
  responsesUtilsDependencies.isContextManagementEnabledForMessages = () => true
  responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
    false
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.codexAccessToken = originalCodexAccessToken
  state.codexAccountId = originalCodexAccountId
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
  providerConfigs = {}
  messageApiWebSearchModel = undefined
  responsesResultOverride = undefined
  responsesStreamFactory = undefined
})

describe("provider messages web_search", () => {
  test("adds context management when provider Messages uses Responses API", async () => {
    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-search",
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://provider.example/v1/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      context_management?: unknown
      model: string
    }
    expect(upstreamBody.model).toBe("gpt-search")
    expect(upstreamBody.context_management).toEqual([
      {
        compact_threshold: 170000,
        type: "compaction",
      },
    ])
  })

  test("routes top-level Copilot messages web_search to provider/model", async () => {
    messageApiWebSearchModel = "search/gpt-search"

    const app = createApp()
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "mai-1-preview",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://provider.example/v1/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
      stream?: boolean
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.model).toBe("gpt-search")
    expect(upstreamBody.stream).toBe(true)
    expect(upstreamBody.tools).toEqual([
      {
        type: "web_search",
        search_context_size: "low",
        filters: {
          allowed_domains: ["nodejs.org"],
        },
        user_location: {
          type: "approximate",
          country: "US",
        },
      },
    ])

    const json = (await response.json()) as AnthropicResponse
    expect(json.model).toBe("gpt-search")
    expect(json.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
  })

  test("rejects a disallowed configured web-search fallback", async () => {
    messageApiWebSearchModel = "search/CLAUDE-sonnet-4"

    const response = await createApp().request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createCodexMessagesPayload({
          model: "mai-1-preview",
          tools: [webSearchTool] as never,
        }),
      ),
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("runs pure Anthropic web_search through an openai-responses provider", async () => {
    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "gpt-search",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://provider.example/v1/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
      stream?: boolean
      tool_choice?: unknown
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.model).toBe("gpt-search")
    expect(upstreamBody.stream).toBe(true)
    expect(upstreamBody.tool_choice).toBeUndefined()
    expect(upstreamBody.tools).toEqual([
      {
        type: "web_search",
        search_context_size: "low",
        filters: {
          allowed_domains: ["nodejs.org"],
        },
        user_location: {
          type: "approximate",
          country: "US",
        },
      },
    ])

    const json = (await response.json()) as AnthropicResponse
    expect(json.model).toBe("gpt-search")
    expect(json.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
    expect(json.usage).toMatchObject({
      input_tokens: 12,
      output_tokens: 7,
      server_tool_use: {
        web_search_requests: 1,
      },
    })
  })

  test("runs codex web_search through streaming Responses", async () => {
    configureCodexProvider()

    const app = createApp()
    const response = await app.request("/codex/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "gpt-search",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://codex.example/backend-api/codex/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)

    const upstreamHeaders = new Headers((init as RequestInit).headers)
    expect(upstreamHeaders.get("accept")).toBe("text/event-stream")

    const json = (await response.json()) as AnthropicResponse
    expect(json.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
  })

  test("streams synthetic Anthropic events after parsing upstream Responses stream", async () => {
    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "gpt-search",
        stream: true,
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)

    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)

    const text = await response.text()
    expect(text).toContain("event: message_start")
    expect(text).toContain("event: content_block_start")
    expect(text).toContain("server_tool_use")
    expect(text).toContain("web_search_tool_result")
    expect(text).toContain("Node.js 24 is the latest LTS.")
    expect(text).toContain("event: message_stop")
  })

  test("strips Anthropic web_search when mixed with normal tools", async () => {
    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-search",
        tools: [
          webSearchTool,
          {
            name: "get_weather",
            input_schema: { type: "object" },
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ])
  })

  test("strips Anthropic web_search before OpenAI-compatible translation", async () => {
    providerConfigs.search = {
      ...providerConfigs.search,
      type: "openai-compatible",
      baseUrl: "https://provider.example/compatible-mode",
      models: {
        "gpt-provider": {
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-provider",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://provider.example/compatible-mode/v1/chat/completions",
    )

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.tools).toEqual([])
  })

  test("collects a Codex stream into JSON when stream is omitted", async () => {
    configureCodexProvider()

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createCodexMessagesPayload()),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")

    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)
    expect(new Headers((init as RequestInit).headers).get("accept")).toBe(
      "text/event-stream",
    )

    const json = (await response.json()) as AnthropicResponse
    expect(json.content).toEqual([{ type: "text", text: "Hello from Codex." }])
    expect(json.stop_reason).toBe("end_turn")
    expect(json.usage).toMatchObject({ input_tokens: 12, output_tokens: 7 })
  })

  test("collects a Codex stream into JSON when stream is false", async () => {
    configureCodexProvider()

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createCodexMessagesPayload({ stream: false, tools: [] }),
      ),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)
    expect((await response.json()) as AnthropicResponse).toMatchObject({
      content: [{ type: "text", text: "Hello from Codex." }],
      stop_reason: "end_turn",
    })
  })

  test("collects a non-stream Codex tool call into Anthropic JSON", async () => {
    configureCodexProvider()
    responsesResultOverride = makeResponsesResult({
      id: "resp_provider_tool_call",
      output: [
        {
          id: "fc-provider-weather",
          type: "function_call",
          call_id: "call-provider-weather",
          name: "get_weather",
          arguments: '{"city":"Shanghai"}',
          status: "completed",
        },
      ],
      output_text: "",
    })

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createCodexMessagesPayload({
          tools: [
            {
              name: "get_weather",
              description: "Get the current weather",
              input_schema: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)

    const json = (await response.json()) as AnthropicResponse
    expect(json.content).toEqual([
      {
        type: "tool_use",
        id: "call-provider-weather",
        name: "get_weather",
        input: { city: "Shanghai" },
      },
    ])
    expect(json.stop_reason).toBe("tool_use")
  })

  test("forces streaming for a Codex follow-up containing tool_result", async () => {
    configureCodexProvider()

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createCodexMessagesPayload({
          messages: [
            { role: "user", content: "What is the weather?" },
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "call-provider-weather",
                  name: "get_weather",
                  input: { city: "Shanghai" },
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "call-provider-weather",
                  content: "Sunny, 30C",
                },
              ],
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      input?: Array<Record<string, unknown>>
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)
    expect(upstreamBody.input).toContainEqual({
      type: "function_call_output",
      call_id: "call-provider-weather",
      output: "Sunny, 30C",
      status: "completed",
    })
    expect((await response.json()) as AnthropicResponse).toMatchObject({
      content: [{ type: "text", text: "Hello from Codex." }],
      stop_reason: "end_turn",
    })
  })

  test("keeps requested Codex streaming as Anthropic SSE", async () => {
    configureCodexProvider()

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createCodexMessagesPayload({ stream: true })),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const text = await response.text()
    expect(text).toContain("event: message_start")
    expect(text).toContain("Hello from Codex.")
    expect(text).toContain("event: message_stop")
  })
})
