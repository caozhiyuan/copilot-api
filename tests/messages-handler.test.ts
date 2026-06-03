import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import {
  compactSummaryPromptStart,
  compactTextOnlyGuard,
} from "../src/lib/compact"

const actualStateModule = await import("../src/lib/state")
const actualConfigModule = await import("../src/lib/config")
const actualModelsModule = await import("../src/lib/models")
const actualRateLimitModule = await import("../src/lib/rate-limit")
const actualUtilsModule = await import("../src/lib/utils")

const state = {
  ...actualStateModule.state,
  manualApprove: false,
  verbose: false,
}

let messagesApiEnabled = true
let modelMappings: Record<string, string> = {}
type SelectedModel = {
  id: string
  supported_endpoints?: Array<string>
}

type FlowCallOptions = {
  compactType?: number
  requestId: string
  requestedModel: string
  sessionId?: string
  subagentMarker?: unknown
  anthropicBetaHeader?: string
}

let selectedModel: SelectedModel | undefined

const findEndpointModel = mock((_: string) => selectedModel)
const checkRateLimit = mock(async () => {})
const handleWithMessagesApi = mock(
  (
    _c: unknown,
    _payload: AnthropicMessagesPayload,
    _options: FlowCallOptions,
  ) => Promise.resolve(new Response("messages")),
)
const handleWithResponsesApi = mock(
  (
    _c: unknown,
    _payload: AnthropicMessagesPayload,
    _options: FlowCallOptions,
  ) => Promise.resolve(new Response("responses")),
)
const handleWithChatCompletions = mock(
  (
    _c: unknown,
    _payload: AnthropicMessagesPayload,
    _options: FlowCallOptions,
  ) => Promise.resolve(new Response("chat")),
)

await mock.module("~/lib/state", () => ({
  ...actualStateModule,
  state,
}))
await mock.module("~/lib/rate-limit", () => ({
  ...actualRateLimitModule,
  checkRateLimit,
}))
await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getSmallModel: () => "small-model",
  isMessagesApiEnabled: () => messagesApiEnabled,
  resolveMappedModel: (model: string) => modelMappings[model] ?? model,
}))
await mock.module("~/lib/models", () => ({
  ...actualModelsModule,
  findEndpointModel,
}))
await mock.module("~/lib/utils", () => ({
  ...actualUtilsModule,
}))
const { handleCompletion, messagesFlowHandlers } = await import(
  "../src/routes/messages/handler"
)

const defaultMessagesFlowHandlers = { ...messagesFlowHandlers }

const createApp = () => {
  const app = new Hono()
  app.post("/", handleCompletion)
  return app
}

const createPayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  model: "original-model",
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
  ...overrides,
})

beforeEach(() => {
  state.manualApprove = false
  state.verbose = false
  messagesApiEnabled = true
  modelMappings = {}
  selectedModel = undefined

  messagesFlowHandlers.handleWithMessagesApi = handleWithMessagesApi
  messagesFlowHandlers.handleWithResponsesApi = handleWithResponsesApi
  messagesFlowHandlers.handleWithChatCompletions = handleWithChatCompletions

  checkRateLimit.mockClear()
  findEndpointModel.mockClear()
  handleWithMessagesApi.mockClear()
  handleWithResponsesApi.mockClear()
  handleWithChatCompletions.mockClear()
})

afterEach(() => {
  messagesFlowHandlers.handleWithMessagesApi =
    defaultMessagesFlowHandlers.handleWithMessagesApi
  messagesFlowHandlers.handleWithResponsesApi =
    defaultMessagesFlowHandlers.handleWithResponsesApi
  messagesFlowHandlers.handleWithChatCompletions =
    defaultMessagesFlowHandlers.handleWithChatCompletions
})

describe("messages handler orchestration", () => {
  test("merges message-level system prompts before forwarding to the selected flow", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const payload: AnthropicMessagesPayload = {
      model: "original-model",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: "hello",
        },
        {
          role: "system",
          content: "follow the repo style",
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "working on it",
            },
          ],
        },
        {
          role: "system",
          content: [
            {
              type: "text",
              text: "keep answers short",
            },
          ],
        },
        {
          role: "user",
          content: "next question",
        },
      ],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.system).toBeUndefined()
    expect(forwardedPayload.messages).toEqual([
      {
        role: "user",
        content:
          "<system-reminder>\nfollow the repo style\n</system-reminder>\n\nhello",
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "working on it",
          },
        ],
      },
      {
        role: "user",
        content: "next question",
      },
    ])
  })

  test("removes executeCode and rewrites getDiagnostics before forwarding tools", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createPayload({
          tools: [
            {
              name: "mcp__ide__executeCode",
              description: "Execute code in VS Code",
              input_schema: { type: "object" },
            },
            {
              name: "mcp__ide__getDiagnostics",
              description: "Old description",
              input_schema: { type: "object" },
            },
            {
              name: "keep_me",
              description: "Keep me",
              input_schema: { type: "object" },
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.tools).toEqual([
      {
        name: "mcp__ide__getDiagnostics",
        description:
          "Get language diagnostics from VS Code. Returns errors, warnings, information, and hints for files in the workspace.",
        input_schema: { type: "object" },
      },
      {
        name: "keep_me",
        description: "Keep me",
        input_schema: { type: "object" },
      },
    ])
  })

  test("adds cache_control to the last content block after merging tool_result content", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const payload: AnthropicMessagesPayload = {
      model: "original-model",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Launching skill: foo",
            },
            {
              type: "text",
              text: "[Pasted ~4 lines]",
            },
          ],
        },
      ],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo\n\n[Pasted ~4 lines]",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })

  test("preserves cache_control captured before Tool loaded is stripped", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const payload: AnthropicMessagesPayload = {
      model: "original-model",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
            },
            {
              type: "text",
              text: "Tool loaded.",
              cache_control: {
                type: "ephemeral",
                scope: "user",
              },
            },
          ],
        },
      ],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
          cache_control: {
            type: "ephemeral",
            scope: "user",
          },
        },
      ],
    })
  })

  test("delegates to the Messages API flow when the model supports /v1/messages", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")
    expect(handleWithMessagesApi).toHaveBeenCalledTimes(1)
    expect(handleWithResponsesApi).not.toHaveBeenCalled()
    expect(handleWithChatCompletions).not.toHaveBeenCalled()

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.model).toBe("messages-model")
  })

  test("maps the requested model before resolving the endpoint model", async () => {
    modelMappings = {
      "claude-opus-4-7": "messages-model",
    }
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(createPayload({ model: "claude-opus-4-7" })),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")
    expect(findEndpointModel).toHaveBeenCalledWith("messages-model")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.model).toBe("messages-model")

    const options = handleWithMessagesApi.mock.calls[0][2]
    expect(options.requestedModel).toBe("claude-opus-4-7")
  })

  test("delegates to the Responses API flow when the model supports /responses", async () => {
    selectedModel = {
      id: "responses-model",
      supported_endpoints: ["/responses"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("responses")
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).toHaveBeenCalledTimes(1)
    expect(handleWithChatCompletions).not.toHaveBeenCalled()
  })

  test("delegates to the Responses API flow when the model supports ws:/responses", async () => {
    selectedModel = {
      id: "responses-ws-model",
      supported_endpoints: ["ws:/responses"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("responses")
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).toHaveBeenCalledTimes(1)
    expect(handleWithChatCompletions).not.toHaveBeenCalled()
  })

  test("does not delegate compact requests to a ws-only Responses API model", async () => {
    selectedModel = {
      id: "responses-ws-model",
      supported_endpoints: ["ws:/responses"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createPayload({
          messages: [
            {
              role: "user",
              content: `${compactTextOnlyGuard}\n\n${compactSummaryPromptStart}\n\nPending Tasks:\n- one\n\nCurrent Work:\n- two`,
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("chat")
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).not.toHaveBeenCalled()
    expect(handleWithChatCompletions).toHaveBeenCalledTimes(1)
  })

  test("falls back to the Chat Completions flow when no endpoint matches", async () => {
    selectedModel = {
      id: "chat-model",
      supported_endpoints: [],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("chat")
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).not.toHaveBeenCalled()
    expect(handleWithChatCompletions).toHaveBeenCalledTimes(1)
  })

  test("applies warmup model override and passes request metadata to the selected flow", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const payload = createPayload({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: '<system-reminder>__SUBAGENT_MARKER__{"session_id":"sub-session","agent_id":"agent-1","agent_type":"Explore"}</system-reminder>',
            },
            {
              type: "text",
              text: "hello",
            },
          ],
        },
      ],
    })

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "warmup-beta",
        "x-session-id": "session-123",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")
    expect(findEndpointModel).toHaveBeenCalledWith("small-model")

    const expectedSessionId = actualUtilsModule.getUUID("session-123")
    const expectedRequestId = actualUtilsModule.generateRequestIdFromPayload(
      payload,
      expectedSessionId,
    )

    const options = handleWithMessagesApi.mock.calls[0][2]
    expect(options.requestId).toBe(expectedRequestId)
    expect(options.requestedModel).toBe("original-model")
    expect(options.sessionId).toBe(expectedSessionId)
    expect(options.subagentMarker).toEqual({
      session_id: "sub-session",
      agent_id: "agent-1",
      agent_type: "Explore",
    })
    expect(options.anthropicBetaHeader).toBe("warmup-beta")
  })
})
