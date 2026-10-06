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

import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"

import { assistantPrefillState } from "~/lib/assistant-prefill"
import { compactSummaryPromptStart, compactTextOnlyGuard } from "~/lib/compact"
import { HTTPError } from "~/lib/error"
import { createFallbackModel } from "~/lib/provider-model"

const actualStateModule = await import("~/lib/state")
const actualConfigModule = await import("~/lib/config")
const actualModelsModule = await import("~/lib/models")
const actualUtilsModule = await import("~/lib/utils")
const { responsesUtilsDependencies } = await import("~/routes/responses/utils")

const state = {
  ...actualStateModule.state,
  tokenBasedBilling: false,
  verbose: false,
}

let messagesApiEnabled = true
let responsesApiWebSocketEnabled = true
let modelMappings: Record<string, string> = {}
let claudeAutoModel: string | undefined
type SelectedModel = {
  id: string
  supported_endpoints?: Array<string>
}

type FlowCallOptions = {
  compactType?: number
  requestId: string
  sessionId?: string
  subagentMarker?: unknown
  anthropicBetaHeader?: string
  initiator?: "agent" | "user"
}

let selectedModel: SelectedModel | undefined
let restoreModelLookup = () => {}

const findEndpointModel = mock((_: string) =>
  selectedModel ?
    { ...createFallbackModel(selectedModel.id), ...selectedModel }
  : undefined,
)
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
await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getClaudeAutoModel: () => claudeAutoModel,
  isMessagesApiEnabled: () => messagesApiEnabled,
  isResponsesApiWebSocketEnabled: () => responsesApiWebSocketEnabled,
  resolveMappedModel: (model: string) => modelMappings[model] ?? model,
}))
await mock.module("~/lib/utils", () => ({
  ...actualUtilsModule,
}))
const { handleCompletion, handleCompletionPayload, messagesFlowHandlers } =
  await import("~/routes/messages/handler")

const defaultMessagesFlowHandlers = { ...messagesFlowHandlers }
const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }

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
  const modelLookup = spyOn(
    actualModelsModule,
    "findEndpointModel",
  ).mockImplementation(findEndpointModel)
  restoreModelLookup = () => modelLookup.mockRestore()

  state.verbose = false
  assistantPrefillState.rejectingModels.clear()
  messagesApiEnabled = true
  responsesApiWebSocketEnabled = true
  modelMappings = {}
  claudeAutoModel = undefined
  selectedModel = undefined

  responsesUtilsDependencies.isResponsesApiWebSocketEnabled = () =>
    responsesApiWebSocketEnabled

  messagesFlowHandlers.handleWithMessagesApi = handleWithMessagesApi
  messagesFlowHandlers.handleWithResponsesApi = handleWithResponsesApi
  messagesFlowHandlers.handleWithChatCompletions = handleWithChatCompletions

  findEndpointModel.mockClear()
  handleWithMessagesApi.mockClear()
  handleWithResponsesApi.mockClear()
  handleWithChatCompletions.mockClear()
})

afterEach(() => {
  restoreModelLookup()
  messagesFlowHandlers.handleWithMessagesApi =
    defaultMessagesFlowHandlers.handleWithMessagesApi
  messagesFlowHandlers.handleWithResponsesApi =
    defaultMessagesFlowHandlers.handleWithResponsesApi
  messagesFlowHandlers.handleWithChatCompletions =
    defaultMessagesFlowHandlers.handleWithChatCompletions
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
})

describe("messages handler orchestration", () => {
  test.each([
    ["my-claude-glm-5.3-flash", "glm-5.3-flash"],
    ["my-claude-glm-5.3-flash[1m]", "glm-5.3-flash"],
    ["contoso/my-claude-family/glm-5.3-flash", "contoso/family/glm-5.3-flash"],
    [
      "contoso/my-claude-family/glm-5.3-flash[1m]",
      "contoso/family/glm-5.3-flash",
    ],
    ["claude-opus-4.8", "claude-opus-4.8"],
    ["claude-opus-4.8[1m]", "claude-opus-4.8"],
    ["glm-5.3-flash", "glm-5.3-flash"],
    ["glm-5.3-flash[1m]", "glm-5.3-flash"],
  ])(
    "resolves discovered Messages ID %s to %s",
    async (model, expectedModel) => {
      const response = await createApp().request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload({ model })),
      })
      expect(response.status).toBe(200)
      expect(findEndpointModel).toHaveBeenCalledWith(expectedModel)
      expect(handleWithChatCompletions.mock.calls[0][1].model).toBe(
        expectedModel,
      )
    },
  )

  test("restores discovery IDs before applying configured model mappings", async () => {
    modelMappings = { "glm-5.3-flash": "messages-model" }
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }
    const response = await createApp().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createPayload({ model: "my-claude-glm-5.3-flash[1m]" }),
      ),
    })
    expect(response.status).toBe(200)
    expect(findEndpointModel).toHaveBeenCalledWith("messages-model")
    expect(handleWithMessagesApi.mock.calls[0][1].model).toBe("messages-model")
  })

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

  test("rewrites getDiagnostics description before forwarding tools", async () => {
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
        name: "mcp__ide__executeCode",
        description: "Execute code in VS Code",
        input_schema: { type: "object" },
      },
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
  })

  test("stabilizes Claude Code billing header before forwarding to the Messages API flow", async () => {
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
          system: [
            {
              type: "text",
              text: "x-anthropic-billing-header: cc_version=2.1.158.c0c; cc_entrypoint=cli; cch=6fb32;",
            },
            {
              type: "text",
              text: "You are Claude Code, Anthropic's official CLI for Claude.",
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.system).toEqual([
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.158.c0c; cc_entrypoint=cli; cch=<stable>;",
      },
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    ])
  })

  test("stabilizes Claude Code billing header before forwarding to the Responses API flow", async () => {
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
      body: JSON.stringify(
        createPayload({
          system: [
            {
              type: "text",
              text: "x-anthropic-billing-header: cc_version=2.1.158.c0c; cc_entrypoint=cli; cch=6fb32;",
            },
            {
              type: "text",
              text: "You are Claude Code, Anthropic's official CLI for Claude.",
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("responses")
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).toHaveBeenCalledTimes(1)
    expect(handleWithChatCompletions).not.toHaveBeenCalled()

    const [, forwardedPayload] = handleWithResponsesApi.mock.calls[0]
    expect(forwardedPayload.system).toEqual([
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.158.c0c; cc_entrypoint=cli; cch=<stable>;",
      },
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    ])
  })

  test("delegates to the Responses API flow when the model supports ws:/responses", async () => {
    responsesApiWebSocketEnabled = true
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

  test("stabilizes Claude Code billing header before falling back to the Chat Completions flow", async () => {
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
      body: JSON.stringify(
        createPayload({
          system: [
            {
              type: "text",
              text: "x-anthropic-billing-header: cc_version=2.1.158.c0c; cc_entrypoint=cli; cch=6fb32;",
            },
            {
              type: "text",
              text: "You are Claude Code, Anthropic's official CLI for Claude.",
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

    const [, forwardedPayload] = handleWithChatCompletions.mock.calls[0]
    expect(forwardedPayload.system).toEqual([
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.158.c0c; cc_entrypoint=cli; cch=<stable>;",
      },
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    ])
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
    expect(findEndpointModel).toHaveBeenCalledWith(
      actualConfigModule.getSmallModel(),
    )

    const expectedSessionId = actualUtilsModule.getUUID("session-123")
    const expectedRequestId = actualUtilsModule.generateRequestIdFromPayload(
      payload,
      expectedSessionId,
    )

    const options = handleWithMessagesApi.mock.calls[0][2]
    expect(options.requestId).toBe(expectedRequestId)
    expect(options.sessionId).toBe(expectedSessionId)
    expect(options.subagentMarker).toEqual({
      session_id: "sub-session",
      agent_id: "agent-1",
      agent_type: "Explore",
    })
    expect(options.anthropicBetaHeader).toBe("warmup-beta")
  })

  test("keeps the Claude auto model override ahead of warmup selection", async () => {
    claudeAutoModel = "auto-model"
    selectedModel = {
      id: "auto-model",
      supported_endpoints: ["/v1/messages"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "warmup-beta",
      },
      body: JSON.stringify(
        createPayload({
          stop_sequences: ["</block>"],
          system: [
            {
              type: "text",
              text: "You are a security monitor for autonomous AI coding agents. Check the changes.",
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")
    expect(findEndpointModel).toHaveBeenCalledTimes(1)
    expect(findEndpointModel).toHaveBeenCalledWith("auto-model")
  })

  test("prefers the root session header when dispatching to the Messages API", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }
    const payload = createPayload()
    const response = await createApp().request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-root-session-id": "root-session",
        "x-session-id": "child-session",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")
    expect(handleWithMessagesApi.mock.calls[0][2].sessionId).toBe(
      actualUtilsModule.getUUID("root-session"),
    )
  })

  test("prefers dispatch-provided session, request, and subagent context", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const dispatchMarker = {
      session_id: "dispatch-sub-session",
      agent_id: "dispatch-agent",
      agent_type: "collab_spawn",
    }

    const app = new Hono()
    app.post("/", (c) =>
      handleCompletionPayload(c, createPayload(), {
        sessionId: "dispatch-session",
        requestId: "dispatch-request",
        subagentMarker: dispatchMarker,
      }),
    )

    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "header-session",
      },
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const options = handleWithMessagesApi.mock.calls[0][2]
    expect(options.sessionId).toBe("dispatch-session")
    expect(options.requestId).toBe("dispatch-request")
    expect(options.subagentMarker).toEqual(dispatchMarker)
  })

  const createUpstreamError = (message: string) =>
    new HTTPError(
      "Failed to create messages",
      Response.json(
        { type: "error", error: { type: "invalid_request_error", message } },
        { status: 400 },
      ),
    )
  const prefillRejectedMessage =
    "This model does not support assistant message prefill. The conversation must end with a user message."
  const prefillMessages: AnthropicMessagesPayload["messages"] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "partial answer" },
  ]

  test("retries with a trailing user turn when the upstream rejects assistant prefill", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }
    handleWithMessagesApi.mockImplementationOnce(() =>
      Promise.reject(createUpstreamError(prefillRejectedMessage)),
    )

    const response = await createApp().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createPayload({ messages: prefillMessages })),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")
    expect(handleWithMessagesApi).toHaveBeenCalledTimes(2)

    const [, retriedPayload] = handleWithMessagesApi.mock.calls[1]
    expect(retriedPayload.messages).toHaveLength(3)
    expect(retriedPayload.messages.slice(0, 2)).toEqual(prefillMessages)
    const lastMessage = retriedPayload.messages.at(-1)
    expect(lastMessage?.role).toBe("user")
    expect(lastMessage?.content).not.toBe("")

    const initiators = handleWithMessagesApi.mock.calls.map(
      ([, , options]) => options.initiator,
    )
    expect(initiators).toEqual([undefined, "agent"])
  })

  test("skips prefill upfront for a model that already rejected it", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }
    handleWithMessagesApi.mockImplementationOnce(() =>
      Promise.reject(createUpstreamError(prefillRejectedMessage)),
    )
    const request = () =>
      createApp().request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload({ messages: prefillMessages })),
      })

    await request()
    handleWithMessagesApi.mockClear()
    const response = await request()

    expect(response.status).toBe(200)
    expect(handleWithMessagesApi).toHaveBeenCalledTimes(1)
    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.messages.at(-1)?.role).toBe("user")
  })

  test("drops a trailing thinking-only assistant turn instead of nudging", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }
    handleWithMessagesApi.mockImplementationOnce(() =>
      Promise.reject(createUpstreamError(prefillRejectedMessage)),
    )

    const response = await createApp().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createPayload({
          messages: [
            { role: "user", content: "hello" },
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "hmm", signature: "sig" },
              ],
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    const [, retriedPayload] = handleWithMessagesApi.mock.calls[1]
    expect(retriedPayload.messages).toEqual([
      { role: "user", content: "hello" },
    ])
  })

  test("forwards assistant prefill untouched when the upstream accepts it", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const response = await createApp().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createPayload({ messages: prefillMessages })),
    })

    expect(response.status).toBe(200)
    expect(handleWithMessagesApi).toHaveBeenCalledTimes(1)
    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.messages).toEqual(prefillMessages)
  })

  test("does not retry other upstream errors and leaves the error body readable", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }
    const upstreamError = createUpstreamError("max_tokens is too large")
    handleWithMessagesApi.mockImplementationOnce(() =>
      Promise.reject(upstreamError),
    )

    const c = {
      req: { header: () => undefined },
    } as unknown as Parameters<typeof handleCompletionPayload>[0]
    const result = handleCompletionPayload(
      c,
      createPayload({ messages: prefillMessages }),
    )

    const thrown = await result.catch((caught: unknown) => caught)
    expect(thrown).toBe(upstreamError)
    expect(handleWithMessagesApi).toHaveBeenCalledTimes(1)
    expect(await upstreamError.response.text()).toContain(
      "max_tokens is too large",
    )
  })
})
