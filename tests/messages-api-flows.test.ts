import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/types/anthropic"
import type { Model } from "~/lib/types/models"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/lib/types/chat-completions"
import type { CreateMessagesReturn } from "~/services/copilot/create-messages"
import type {
  CreateResponsesReturn,
  ResponsesPayload,
  ResponsesResult,
  ResponsesTransport,
} from "~/lib/types/responses"

import { COMPACT_REQUEST } from "~/lib/compact"
import { closeUsageStore, getTokenUsageEventsPage } from "~/lib/token-usage"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

let capturedPayload: ChatCompletionsPayload | null = null
let capturedMessagesPayload: AnthropicMessagesPayload | null = null
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
const createMessages = mock(
  (payload: AnthropicMessagesPayload): Promise<CreateMessagesReturn> => {
    capturedMessagesPayload = payload
    return Promise.resolve(createMessagesResult(payload.model))
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
  handleWithMessagesApi,
  handleWithResponsesApi,
  messagesApiFlowDependencies,
  prepareCopilotChatCompletionsPayload,
} = await import("~/routes/messages/api-flows")
const { responsesUtilsDependencies } = await import("~/routes/responses/utils")

const defaultMessagesApiFlowDependencies = { ...messagesApiFlowDependencies }
const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }

const logger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Parameters<typeof handleWithChatCompletions>[2]["logger"]

const createContext = () =>
  ({
    json: (body: unknown) => Response.json(body),
  }) as Parameters<typeof handleWithChatCompletions>[0]

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  capturedPayload = null
  capturedMessagesPayload = null
  capturedResponsesPayload = null
  capturedResponsesOptions = null
  responsesApiWebSocketEnabled = true
  messagesApiFlowDependencies.createChatCompletions = createChatCompletions
  messagesApiFlowDependencies.createMessages = createMessages
  messagesApiFlowDependencies.createResponses = createResponses
  responsesUtilsDependencies.getModelResponsesApiCompactThreshold = () =>
    undefined
  responsesUtilsDependencies.isContextManagementEnabledForMessages = () => true
  responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
    false
  responsesUtilsDependencies.isResponsesApiWebSocketEnabled = () =>
    responsesApiWebSocketEnabled
  createChatCompletions.mockClear()
  createMessages.mockClear()
  createResponses.mockClear()
})

afterEach(async () => {
  Object.assign(messagesApiFlowDependencies, defaultMessagesApiFlowDependencies)
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
})

test("messages Chat Completions flow adds Copilot cache control to system and latest non-system message", async () => {
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

test("messages Chat Completions flow preserves supported reasoning effort", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "gpt-test",
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    output_config: {
      effort: "medium",
    },
  }

  const response = await handleWithChatCompletions(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel([], {
      reasoningEffort: ["low", "medium", "high"],
    }),
  })

  expect(response.status).toBe(200)
  expect(capturedPayload?.reasoning_effort).toBe("medium")
})

test("messages Chat Completions flow downgrades unsupported reasoning effort", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "gpt-test",
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    output_config: {
      effort: "xhigh",
    },
  }

  const response = await handleWithChatCompletions(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel([], {
      reasoningEffort: ["low", "medium", "high"],
    }),
  })

  expect(response.status).toBe(200)
  expect(capturedPayload?.reasoning_effort).toBe("high")
})

test("messages Chat Completions flow omits reasoning effort without model support", async () => {
  const createPayload = (): AnthropicMessagesPayload => ({
    model: "gpt-test",
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    output_config: {
      effort: "high",
    },
  })

  let response = await handleWithChatCompletions(
    createContext(),
    createPayload(),
    {
      logger,
      requestId: "request-1",
      selectedModel: createModel([]),
    },
  )

  expect(response.status).toBe(200)
  expect(capturedPayload).not.toHaveProperty("reasoning_effort")

  capturedPayload = null
  createChatCompletions.mockClear()

  response = await handleWithChatCompletions(createContext(), createPayload(), {
    logger,
    requestId: "request-2",
    selectedModel: createModel([], {
      reasoningEffort: [],
    }),
  })

  expect(response.status).toBe(200)
  expect(capturedPayload).not.toHaveProperty("reasoning_effort")
})

test("messages Chat Completions flow emits an error event when the stream breaks during thinking output", async () => {
  createChatCompletions.mockImplementationOnce(
    (payload: ChatCompletionsPayload) => {
      capturedPayload = payload
      const stream = createChatCompletionsStream([
        {
          id: "chatcmpl-thinking-cut",
          object: "chat.completion.chunk",
          created: 0,
          model: payload.model,
          choices: [
            {
              index: 0,
              delta: { reasoning_text: "partial thought" },
              finish_reason: null,
              logprobs: null,
            },
          ],
        },
        // The stream ends here: no [DONE], no finish_reason, no usage.
      ])
      return Promise.resolve(
        stream,
      ) as unknown as Promise<ChatCompletionResponse>
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithChatCompletions(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const events = parseSseEvents(await response.text())
  const eventTypes = events.map((event) => event.event)

  expect(eventTypes).toContain("message_start")
  expect(eventTypes).toContain("content_block_delta")
  expect(eventTypes).not.toContain("message_stop")
  expect(events.at(-1)?.event).toBe("error")
  expect(JSON.parse(events.at(-1)?.data ?? "{}")).toEqual({
    type: "error",
    error: {
      message:
        "An unexpected error occurred during streaming, retry your request.",
      type: "api_error",
    },
  })
})

test("messages Chat Completions flow emits an error event when the upstream stream throws", async () => {
  createChatCompletions.mockImplementationOnce(
    (payload: ChatCompletionsPayload) => {
      capturedPayload = payload
      const stream = (async function* (): AsyncGenerator<{ data: string }> {
        await Promise.resolve()
        yield {
          data: JSON.stringify({
            id: "chatcmpl-throw",
            object: "chat.completion.chunk",
            created: 0,
            model: payload.model,
            choices: [
              {
                index: 0,
                delta: { content: "partial" },
                finish_reason: null,
                logprobs: null,
              },
            ],
          }),
        }
        throw new Error("upstream connection reset")
      })()
      return Promise.resolve(
        stream,
      ) as unknown as Promise<ChatCompletionResponse>
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithChatCompletions(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const events = parseSseEvents(await response.text())
  const eventTypes = events.map((event) => event.event)

  expect(eventTypes).toContain("message_start")
  expect(eventTypes).not.toContain("message_stop")
  expect(events.at(-1)?.event).toBe("error")
})

test("messages Chat Completions flow ends without an error event on normal completion", async () => {
  createChatCompletions.mockImplementationOnce(
    (payload: ChatCompletionsPayload) => {
      capturedPayload = payload
      const stream = createChatCompletionsStream([
        {
          id: "chatcmpl-ok",
          object: "chat.completion.chunk",
          created: 0,
          model: payload.model,
          choices: [
            {
              index: 0,
              delta: { content: "hello" },
              finish_reason: null,
              logprobs: null,
            },
          ],
        },
        {
          id: "chatcmpl-ok",
          object: "chat.completion.chunk",
          created: 0,
          model: payload.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        },
        "[DONE]",
      ])
      return Promise.resolve(
        stream,
      ) as unknown as Promise<ChatCompletionResponse>
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithChatCompletions(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const events = parseSseEvents(await response.text())
  const eventTypes = events.map((event) => event.event)

  expect(eventTypes).toContain("message_delta")
  expect(eventTypes).toContain("message_stop")
  expect(eventTypes).not.toContain("error")
})

test("Copilot Chat Completions payload preparation marks two system and latest non-system message", () => {
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

test("messages Messages flow records Copilot AIU from streaming message delta", async () => {
  createMessages.mockImplementationOnce(
    (payload: AnthropicMessagesPayload): Promise<CreateMessagesReturn> => {
      capturedMessagesPayload = payload
      return Promise.resolve(
        createMessagesStream([
          {
            event: "message_start",
            data: JSON.stringify({
              message: {
                content: [],
                id: "msg-test",
                model: payload.model,
                role: "assistant",
                stop_reason: null,
                stop_sequence: null,
                type: "message",
                usage: {
                  input_tokens: 3,
                  output_tokens: 0,
                },
              },
              type: "message_start",
            }),
          },
          {
            event: "message_delta",
            data: JSON.stringify({
              copilot_usage: {
                total_nano_aiu: 4_119_900_000,
              },
              delta: {
                stop_reason: "end_turn",
                stop_sequence: null,
              },
              type: "message_delta",
              usage: {
                cache_creation_input_tokens: 10_612,
                cache_read_input_tokens: 0,
                input_tokens: 3,
                output_tokens: 93,
              },
            }),
          },
          {
            event: "message_stop",
            data: JSON.stringify({ type: "message_stop" }),
          },
        ]) as unknown as CreateMessagesReturn,
      )
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-5.4",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithMessagesApi(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  await response.text()

  const usageEvents = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "today",
  })

  expect(capturedMessagesPayload?.model).toBe("gpt-5.4")
  expect(usageEvents.items).toHaveLength(1)
  expect(usageEvents.items[0]).toMatchObject({
    cache_creation_input_tokens: 10_612,
    cache_read_input_tokens: 0,
    cost: {
      amount: 0.041199,
      currency: "USD",
      source: "copilot_aiu",
      total_cost_nanos: 41_199_000,
    },
    input_tokens: 3,
    model: "gpt-5.4",
    output_tokens: 93,
    total_nano_aiu: 4_119_900_000,
  })
})

test("messages Messages flow emits an error event when the stream ends without message_stop", async () => {
  createMessages.mockImplementationOnce(
    (payload: AnthropicMessagesPayload): Promise<CreateMessagesReturn> => {
      capturedMessagesPayload = payload
      return Promise.resolve(
        createMessagesStream([
          {
            event: "message_start",
            data: JSON.stringify({
              message: {
                content: [],
                id: "msg-cut",
                model: payload.model,
                role: "assistant",
                stop_reason: null,
                stop_sequence: null,
                type: "message",
                usage: {
                  input_tokens: 3,
                  output_tokens: 0,
                },
              },
              type: "message_start",
            }),
          },
          {
            event: "content_block_delta",
            data: JSON.stringify({
              delta: { text: "partial", type: "text_delta" },
              index: 0,
              type: "content_block_delta",
            }),
          },
          // The stream ends here: no message_stop and no [DONE].
        ]) as unknown as CreateMessagesReturn,
      )
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-5.4",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithMessagesApi(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const events = parseSseEvents(await response.text())
  const eventTypes = events.map((event) => event.event)

  expect(eventTypes).toContain("message_start")
  expect(eventTypes).not.toContain("message_stop")
  expect(events.at(-1)?.event).toBe("error")
  expect(JSON.parse(events.at(-1)?.data ?? "{}")).toEqual({
    type: "error",
    error: {
      message:
        "An unexpected error occurred during streaming, retry your request.",
      type: "api_error",
    },
  })
})

test("messages Messages flow emits an error event when the upstream stream throws", async () => {
  createMessages.mockImplementationOnce(
    (payload: AnthropicMessagesPayload): Promise<CreateMessagesReturn> => {
      capturedMessagesPayload = payload
      const stream = (async function* (): AsyncGenerator<{
        data: string
        event: string
      }> {
        await Promise.resolve()
        yield {
          event: "message_start",
          data: JSON.stringify({
            message: {
              content: [],
              id: "msg-throw",
              model: payload.model,
              role: "assistant",
              stop_reason: null,
              stop_sequence: null,
              type: "message",
              usage: {
                input_tokens: 3,
                output_tokens: 0,
              },
            },
            type: "message_start",
          }),
        }
        throw new Error("upstream connection reset")
      })()
      return Promise.resolve(stream) as unknown as Promise<CreateMessagesReturn>
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-5.4",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithMessagesApi(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const events = parseSseEvents(await response.text())
  const eventTypes = events.map((event) => event.event)

  expect(eventTypes).toContain("message_start")
  expect(eventTypes).not.toContain("message_stop")
  expect(events.at(-1)?.event).toBe("error")
})

test("messages Messages flow forwards an upstream error event without appending another", async () => {
  const upstreamError = JSON.stringify({
    error: { message: "overloaded", type: "overloaded_error" },
    type: "error",
  })
  createMessages.mockImplementationOnce(
    (): Promise<CreateMessagesReturn> =>
      Promise.resolve(
        createMessagesStream([
          {
            event: "error",
            data: upstreamError,
          },
          // The stream ends here without message_stop.
        ]) as unknown as CreateMessagesReturn,
      ),
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-5.4",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithMessagesApi(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const events = parseSseEvents(await response.text())

  expect(events).toEqual([{ data: upstreamError, event: "error" }])
})

test("messages Messages flow ends without an error event on normal completion", async () => {
  createMessages.mockImplementationOnce(
    (payload: AnthropicMessagesPayload): Promise<CreateMessagesReturn> => {
      capturedMessagesPayload = payload
      return Promise.resolve(
        createMessagesStream([
          {
            event: "message_start",
            data: JSON.stringify({
              message: {
                content: [],
                id: "msg-ok",
                model: payload.model,
                role: "assistant",
                stop_reason: null,
                stop_sequence: null,
                type: "message",
                usage: {
                  input_tokens: 3,
                  output_tokens: 0,
                },
              },
              type: "message_start",
            }),
          },
          {
            event: "message_stop",
            data: JSON.stringify({ type: "message_stop" }),
          },
          {
            event: "message_stop",
            data: "[DONE]",
          },
        ]) as unknown as CreateMessagesReturn,
      )
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-5.4",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithMessagesApi(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const eventTypes = parseSseEvents(await response.text()).map(
    (event) => event.event,
  )

  expect(eventTypes).toContain("message_stop")
  expect(eventTypes).not.toContain("error")
})

test("messages Messages flow records Copilot AIU from non-streaming response", async () => {
  createMessages.mockImplementationOnce(
    (payload: AnthropicMessagesPayload): Promise<CreateMessagesReturn> => {
      capturedMessagesPayload = payload
      return Promise.resolve({
        ...createMessagesResult(payload.model),
        copilot_usage: {
          total_nano_aiu: 1_000_000_000,
        },
        usage: {
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 30,
          input_tokens: 12,
          output_tokens: 8,
        },
      })
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-5.4",
  }

  const response = await handleWithMessagesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
  })
  expect(response.status).toBe(200)
  await response.json()

  const usageEvents = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "today",
  })

  expect(capturedMessagesPayload?.model).toBe("gpt-5.4")
  expect(usageEvents.items).toHaveLength(1)
  expect(usageEvents.items[0]).toMatchObject({
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 30,
    cost: {
      amount: 0.01,
      currency: "USD",
      source: "copilot_aiu",
      total_cost_nanos: 10_000_000,
    },
    input_tokens: 12,
    model: "gpt-5.4",
    output_tokens: 8,
    total_nano_aiu: 1_000_000_000,
  })
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

test("messages Responses flow adds context management by default", async () => {
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
  expect(capturedResponsesPayload?.context_management).toEqual([
    {
      type: "compaction",
      compact_threshold: 108800,
    },
  ])
})

test("messages Responses flow disables context management for gpt-5.6 models", async () => {
  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-5.6-sol",
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses"]),
  })

  expect(response.status).toBe(200)
  expect(createResponses).toHaveBeenCalledTimes(1)
  expect(capturedResponsesPayload?.context_management).toBeUndefined()
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

const createModel = (
  supportedEndpoints: Array<string>,
  options: { reasoningEffort?: Array<string> } = {},
): Model => ({
  capabilities: {
    family: "gpt",
    limits: {
      max_prompt_tokens: 128000,
    },
    object: "model_capabilities",
    supports:
      options.reasoningEffort === undefined ?
        {}
      : { reasoning_effort: options.reasoningEffort },
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

const createMessagesResult = (model: string): AnthropicResponse => ({
  content: [],
  id: "msg-test",
  model,
  role: "assistant",
  stop_reason: "end_turn",
  stop_sequence: null,
  type: "message",
  usage: {
    input_tokens: 0,
    output_tokens: 0,
  },
})

async function* createMessagesStream(
  events: Array<{ data: string; event: string }>,
): AsyncGenerator<{ data: string; event: string }> {
  for (const event of events) {
    await Promise.resolve()
    yield event
  }
}

async function* createChatCompletionsStream(
  chunks: Array<ChatCompletionChunk | string>,
): AsyncGenerator<{ data: string }> {
  for (const chunk of chunks) {
    await Promise.resolve()
    yield { data: typeof chunk === "string" ? chunk : JSON.stringify(chunk) }
  }
}

const parseSseEvents = (
  text: string,
): Array<{ data: string; event: string }> => {
  const events: Array<{ data: string; event: string }> = []
  let eventName = ""
  for (const line of text.split("\n")) {
    if (line.startsWith("event: ")) {
      eventName = line.slice("event: ".length).trim()
    } else if (line.startsWith("data: ")) {
      events.push({ data: line.slice("data: ".length), event: eventName })
    }
  }
  return events
}

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
