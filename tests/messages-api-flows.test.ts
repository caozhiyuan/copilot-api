import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"
import type { Model } from "../src/services/copilot/get-models"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../src/services/copilot/create-chat-completions"
import type {
  CreateResponsesReturn,
  ResponsesPayload,
  ResponsesResult,
  ResponsesTransport,
} from "../src/services/copilot/create-responses"

import { COMPACT_REQUEST } from "../src/lib/compact"

let capturedPayload: ChatCompletionsPayload | null = null
let capturedResponsesPayload: ResponsesPayload | null = null
let capturedResponsesOptions: {
  transport?: ResponsesTransport
} | null = null
let responsesApiWebSocketEnabled = true

const createChatCompletions = mock(
  (payload: ChatCompletionsPayload): Promise<ChatCompletionResponse> => {
    capturedPayload = payload
    return Promise.resolve({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: payload.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "ok",
          },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
    })
  },
)
const createResponses = mock(
  (
    payload: ResponsesPayload,
    options: {
      transport?: ResponsesTransport
    },
  ): Promise<CreateResponsesReturn> => {
    capturedResponsesPayload = payload
    capturedResponsesOptions = options
    return Promise.resolve(createResponsesResult(payload.model))
  },
)

const {
  handleWithChatCompletions,
  handleWithResponsesApi,
  messagesApiFlowDependencies,
  prepareCopilotChatCompletionsPayload,
} = await import("../src/routes/messages/api-flows")
const { closeUsageStore } = await import("../src/lib/token-usage")
const { responsesUtilsDependencies } = await import(
  "../src/routes/responses/utils"
)
const { tokenUsageRoute } = await import("../src/routes/token-usage/route")

const defaultMessagesApiFlowDependencies = { ...messagesApiFlowDependencies }
const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }
const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

const logger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Parameters<typeof handleWithChatCompletions>[2]["logger"]

const createContext = () =>
  ({
    json: (body: unknown) => Response.json(body),
  }) as Parameters<typeof handleWithChatCompletions>[0]

async function* streamChunks(items: Array<Record<string, unknown>>) {
  await Promise.resolve()
  for (const item of items) {
    yield item
  }
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  capturedPayload = null
  capturedResponsesPayload = null
  capturedResponsesOptions = null
  responsesApiWebSocketEnabled = true
  messagesApiFlowDependencies.createChatCompletions = createChatCompletions
  messagesApiFlowDependencies.createResponses = createResponses
  responsesUtilsDependencies.isResponsesApiWebSocketEnabled = () =>
    responsesApiWebSocketEnabled
  createChatCompletions.mockClear()
  createResponses.mockClear()
})

afterEach(async () => {
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  Object.assign(messagesApiFlowDependencies, defaultMessagesApiFlowDependencies)
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
})

test("messages Chat Completions flow adds Copilot cache control to system and latest two non-system messages", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "gpt-test",
    max_tokens: 128,
    system: [
      {
        type: "text",
        text: "system prompt",
      },
    ],
    messages: [
      { role: "user", content: "first user" },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "second user",
          },
        ],
      },
      { role: "assistant", content: "older answer" },
      { role: "user", content: "latest user" },
      { role: "assistant", content: "latest answer" },
    ],
  }

  const response = await handleWithChatCompletions(createContext(), payload, {
    logger,
    requestId: "request-1",
  })

  expect(response.status).toBe(200)
  expect(createChatCompletions).toHaveBeenCalledTimes(1)
  expect(capturedPayload?.messages).toEqual([
    {
      role: "system",
      content: "system prompt",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
    {
      role: "user",
      content: "first user",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "second user",
        },
      ],
    },
    {
      role: "assistant",
      content: "older answer",
    },
    {
      role: "user",
      content: "latest user",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
    {
      role: "assistant",
      content: "latest answer",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
  ])
})

test("Copilot Chat Completions payload preparation marks two system and latest two non-system messages", () => {
  const payload: ChatCompletionsPayload = {
    model: "gpt-test",
    messages: [
      { role: "system", content: "system one" },
      { role: "system", content: "system two" },
      { role: "system", content: "system three" },
      { role: "user", content: "older user" },
      { role: "assistant", content: "older assistant" },
      { role: "user", content: "latest user" },
      { role: "assistant", content: "latest assistant" },
    ],
  }

  prepareCopilotChatCompletionsPayload(payload)

  expect(payload.messages).toEqual([
    {
      role: "system",
      content: "system one",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
    {
      role: "system",
      content: "system two",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
    {
      role: "system",
      content: "system three",
    },
    {
      role: "user",
      content: "older user",
    },
    {
      role: "assistant",
      content: "older assistant",
    },
    {
      role: "user",
      content: "latest user",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
    {
      role: "assistant",
      content: "latest assistant",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
  ])
})

test("messages Responses flow uses websocket transport by default for dual-endpoint models", async () => {
  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses", "ws:/responses"]),
  })

  expect(response.status).toBe(200)
  expect(createResponses).toHaveBeenCalledTimes(1)
  expect(capturedResponsesOptions?.transport).toBe("websocket")
})

test("messages Responses flow keeps HTTP transport for dual-endpoint models when websocket is disabled", async () => {
  responsesApiWebSocketEnabled = false
  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses", "ws:/responses"]),
  })

  expect(response.status).toBe(200)
  expect(createResponses).toHaveBeenCalledTimes(1)
  expect(capturedResponsesOptions?.transport).toBe("http")
})

test("messages Responses flow keeps HTTP transport for compact requests", async () => {
  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "compact" }],
    model: "gpt-test",
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    compactType: COMPACT_REQUEST,
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses", "ws:/responses"]),
  })

  expect(response.status).toBe(200)
  expect(createResponses).toHaveBeenCalledTimes(1)
  expect(capturedResponsesOptions?.transport).toBe("http")
})

test("messages Responses flow keeps HTTP transport for /responses-only models", async () => {
  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses"]),
  })

  expect(response.status).toBe(200)
  expect(createResponses).toHaveBeenCalledTimes(1)
  expect(capturedResponsesOptions?.transport).toBe("http")
})

test("messages Responses flow keeps streaming transport for deferred tool search", async () => {
  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    stream: true,
    messages: [{ role: "user", content: "fetch a page" }],
    model: "gpt-5.4",
    tools: [
      {
        name: "mcp__tool_search__search",
        input_schema: { type: "object" },
      },
      {
        name: "mcp__fetch__fetch",
        description: "Fetch a URL",
        input_schema: { type: "object" },
      },
    ],
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses", "ws:/responses"]),
  })

  expect(response.status).toBe(200)
  expect(createResponses).toHaveBeenCalledTimes(1)
  expect(capturedResponsesPayload?.stream).toBe(true)
  expect(capturedResponsesOptions?.transport).toBe("websocket")
})

test("messages Responses flow records top-level copilot_usage from terminal stream events", async () => {
  createResponses.mockImplementationOnce(
    (
      payload: ResponsesPayload,
      options: { transport?: ResponsesTransport },
    ) => {
      capturedResponsesPayload = payload
      capturedResponsesOptions = options
      return Promise.resolve(
        streamChunks([
          {
            event: "response.completed",
            data: JSON.stringify({
              type: "response.completed",
              copilot_usage: {
                token_details: [
                  {
                    batch_size: 1_000_000,
                    cost_per_batch: 25_000_000_000,
                    token_count: 4,
                    token_type: "input",
                  },
                  {
                    batch_size: 1_000_000,
                    cost_per_batch: 2_500_000_000,
                    token_count: 1,
                    token_type: "cache_read",
                  },
                  {
                    batch_size: 1_000_000,
                    cost_per_batch: 200_000_000_000,
                    token_count: 2,
                    token_type: "output",
                  },
                ],
                total_nano_aiu: 502_500,
              },
              response: {
                ...createResponsesResult(payload.model),
                usage: {
                  input_tokens: 5,
                  input_tokens_details: { cached_tokens: 1 },
                  output_tokens: 2,
                  total_tokens: 7,
                },
              },
            }),
          },
        ]),
      )
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    stream: true,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
  }

  const app = new Hono()
  app.post("/messages-responses", (c) =>
    handleWithResponsesApi(c, payload, {
      logger,
      requestId: "request-1",
      selectedModel: createModel(["/responses"]),
      sessionId: "stream-session",
    }),
  )
  app.route("/token-usage", tokenUsageRoute)

  const response = await app.request("/messages-responses", {
    method: "POST",
  })

  expect(response.status).toBe(200)
  await response.text()

  const eventsResponse = await app.request(
    "/token-usage/events?period=day&page=1&page_size=10",
  )
  expect(eventsResponse.status).toBe(200)

  const page = (await eventsResponse.json()) as {
    items: Array<{
      nano_cost_cache_read: number | null
      nano_cost_input: number | null
      nano_cost_output: number | null
      session_id: string
      total_nano_aiu: number | null
    }>
  }

  expect(page.items).toHaveLength(1)
  expect(page.items[0]?.session_id).toBe("stream-session")
  expect(page.items[0]?.nano_cost_cache_read).toBe(2_500)
  expect(page.items[0]?.nano_cost_input).toBe(100_000)
  expect(page.items[0]?.nano_cost_output).toBe(400_000)
  expect(page.items[0]?.total_nano_aiu).toBe(502_500)
})

test("messages Responses flow preserves the configured tool_search alias in non-streaming responses", async () => {
  createResponses.mockImplementationOnce(
    (
      payload: ResponsesPayload,
      options: { transport?: ResponsesTransport },
    ) => {
      capturedResponsesPayload = payload
      capturedResponsesOptions = options
      return Promise.resolve({
        ...createResponsesResult(payload.model),
        output: [
          {
            id: "search-1",
            type: "tool_search_call",
            call_id: "call_search",
            arguments: { names: ["mcp__fetch__fetch"] },
            status: "completed",
          },
        ],
      })
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "fetch a page" }],
    model: "gpt-5.4",
    tools: [
      {
        name: "tool_search_search",
        input_schema: { type: "object" },
      },
      {
        name: "mcp__fetch__fetch",
        description: "Fetch a URL",
        input_schema: { type: "object" },
      },
    ],
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses"]),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    id: "resp-test",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "call_search",
        name: "tool_search_search",
        input: {
          names: "mcp__fetch__fetch",
        },
      },
    ],
    model: "gpt-5.4",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  })
})

const createModel = (supportedEndpoints: Array<string>): Model => ({
  capabilities: {
    family: "gpt",
    limits: {
      max_prompt_tokens: 128000,
    },
    object: "model_capabilities",
    supports: {},
    tokenizer: "o200k_base",
    type: "chat",
  },
  id: "gpt-test",
  model_picker_enabled: true,
  name: "gpt-test",
  object: "model",
  preview: false,
  supported_endpoints: supportedEndpoints,
  vendor: "openai",
  version: "1",
})

const createResponsesResult = (model: string): ResponsesResult => ({
  created_at: 0,
  error: null,
  id: "resp-test",
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
