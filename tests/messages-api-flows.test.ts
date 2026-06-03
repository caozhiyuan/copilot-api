import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"
import type { Model } from "../src/services/copilot/get-models"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../src/services/copilot/create-chat-completions"
import type { CreateMessagesReturn } from "../src/services/copilot/create-messages"
import type {
  CreateResponsesReturn,
  ResponsesPayload,
  ResponsesResult,
  ResponsesTransport,
} from "../src/services/copilot/create-responses"

import { COMPACT_REQUEST } from "../src/lib/compact"
import { formatCopilotModelLog } from "../src/services/copilot/model-log"

let capturedPayload: ChatCompletionsPayload | null = null
let capturedResponsesPayload: ResponsesPayload | null = null
let capturedResponsesOptions: {
  requestedModel?: string
  transport?: ResponsesTransport
} | null = null
let capturedMessagesOptions: {
  requestedModel?: string
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
      requestedModel?: string
      transport?: ResponsesTransport
    },
  ): Promise<CreateResponsesReturn> => {
    capturedResponsesPayload = payload
    capturedResponsesOptions = options
    return Promise.resolve(createResponsesResult(payload.model))
  },
)
const createMessages = mock(
  (
    payload: AnthropicMessagesPayload,
    _anthropicBetaHeader: string | undefined,
    options: {
      requestedModel?: string
    },
  ): Promise<CreateMessagesReturn> => {
    capturedMessagesOptions = options
    return Promise.resolve({
      id: "msg-test",
      type: "message",
      role: "assistant",
      content: [],
      model: payload.model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    })
  },
)

const {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
  messagesApiFlowDependencies,
  prepareCopilotChatCompletionsPayload,
} = await import("../src/routes/messages/api-flows")
const { responsesUtilsDependencies } = await import(
  "../src/routes/responses/utils"
)

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

beforeEach(() => {
  capturedPayload = null
  capturedResponsesPayload = null
  capturedResponsesOptions = null
  capturedMessagesOptions = null
  responsesApiWebSocketEnabled = true
  messagesApiFlowDependencies.createChatCompletions = createChatCompletions
  messagesApiFlowDependencies.createMessages = createMessages
  messagesApiFlowDependencies.createResponses = createResponses
  responsesUtilsDependencies.isResponsesApiWebSocketEnabled = () =>
    responsesApiWebSocketEnabled
  createChatCompletions.mockClear()
  createMessages.mockClear()
  createResponses.mockClear()
})

afterEach(() => {
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
    requestedModel: "gpt-test",
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

test("messages native flow passes requested model metadata to Copilot messages", async () => {
  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "claude-opus-4.8",
  }

  const response = await handleWithMessagesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    requestedModel: "claude-opus-4.7",
  })

  expect(response.status).toBe(200)
  expect(createMessages).toHaveBeenCalledTimes(1)
  expect(capturedMessagesOptions?.requestedModel).toBe("claude-opus-4.7")
})

test("Copilot model log includes requested model inline when provided", () => {
  expect(formatCopilotModelLog("claude-opus-4.8", "claude-opus-4.7")).toBe(
    "<-- model: claude-opus-4.8 <-- requested model: claude-opus-4.7",
  )
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
    requestedModel: "gpt-test",
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
    requestedModel: "gpt-test",
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
    requestedModel: "gpt-test",
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
    requestedModel: "gpt-test",
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
    requestedModel: "gpt-5.4",
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
      options: { requestedModel?: string; transport?: ResponsesTransport },
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
    requestedModel: "gpt-5.4",
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
