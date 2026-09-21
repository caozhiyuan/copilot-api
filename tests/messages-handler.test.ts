import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"

import { compactSummaryPromptStart, compactTextOnlyGuard } from "~/lib/compact"
import { forwardError } from "~/lib/error"

const actualStateModule = await import("~/lib/state")
const actualConfigModule = await import("~/lib/config")
const actualModelsModule = await import("~/lib/models")
const actualUtilsModule = await import("~/lib/utils")
const { responsesUtilsDependencies } = await import("~/routes/responses/utils")
const { providerMessagesHandlerDependencies } = await import(
  "~/routes/provider/messages/handler"
)

const state = {
  ...actualStateModule.state,
  tokenBasedBilling: false,
  verbose: false,
}

let messagesApiEnabled = true
let responsesApiWebSocketEnabled = true
let modelMappings: Record<string, string> = {}
let smallModel = "gpt-small-model"
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
}

let selectedModel: SelectedModel | undefined

const findEndpointModel = mock((_: string) => selectedModel)
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
  getSmallModel: () => smallModel,
  isMessagesApiEnabled: () => messagesApiEnabled,
  isResponsesApiWebSocketEnabled: () => responsesApiWebSocketEnabled,
  resolveMappedModel: (model: string) => modelMappings[model] ?? model,
}))
await mock.module("~/lib/models", () => ({
  ...actualModelsModule,
  findEndpointModel,
}))
await mock.module("~/lib/utils", () => ({
  ...actualUtilsModule,
}))
const { handleCompletion, handleCompletionPayload, messagesFlowHandlers } =
  await import("~/routes/messages/handler")

const defaultMessagesFlowHandlers = { ...messagesFlowHandlers }
const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }
const defaultProviderMessagesHandlerDependencies = {
  ...providerMessagesHandlerDependencies,
}

const createApp = () => {
  const app = new Hono()
  app.onError((error, c) => forwardError(c, error))
  app.post("/", handleCompletion)
  return app
}

const createPayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  model: "gpt-original-model",
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
  ...overrides,
})

beforeEach(() => {
  state.verbose = false
  messagesApiEnabled = true
  responsesApiWebSocketEnabled = true
  modelMappings = {}
  smallModel = "gpt-small-model"
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
  messagesFlowHandlers.handleWithMessagesApi =
    defaultMessagesFlowHandlers.handleWithMessagesApi
  messagesFlowHandlers.handleWithResponsesApi =
    defaultMessagesFlowHandlers.handleWithResponsesApi
  messagesFlowHandlers.handleWithChatCompletions =
    defaultMessagesFlowHandlers.handleWithChatCompletions
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
  Object.assign(
    providerMessagesHandlerDependencies,
    defaultProviderMessagesHandlerDependencies,
  )
})

describe("messages handler orchestration", () => {
  test("merges message-level system prompts before forwarding to the selected flow", async () => {
    selectedModel = {
      id: "mai-messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const payload: AnthropicMessagesPayload = {
      model: "mai-original-model",
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
      id: "gpt-messages-model",
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
      id: "gpt-messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const payload: AnthropicMessagesPayload = {
      model: "gpt-original-model",
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
      id: "gpt-messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const payload: AnthropicMessagesPayload = {
      model: "gpt-original-model",
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
      id: "gpt-original-model",
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
    expect(forwardedPayload.model).toBe("gpt-original-model")
  })

  test("maps the requested model before resolving the endpoint model", async () => {
    modelMappings = {
      "claude-opus-4-7": "gpt-messages-model",
    }
    selectedModel = {
      id: "gpt-messages-model",
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
    expect(findEndpointModel).toHaveBeenCalledWith("gpt-messages-model")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.model).toBe("gpt-messages-model")
  })

  test("stabilizes Claude Code billing header before forwarding to the Messages API flow", async () => {
    selectedModel = {
      id: "gpt-messages-model",
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
      id: "gpt-responses-model",
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
      id: "gpt-responses-ws-model",
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
      id: "gpt-responses-ws-model",
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
      id: "gpt-chat-model",
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
      id: "gpt-messages-model",
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
    expect(findEndpointModel).toHaveBeenCalledWith("gpt-small-model")

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

  test("dispatches a mapped warmup model to its configured provider", async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = mock(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          Response.json({
            id: "msg-provider",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "provider response" }],
            model: "gpt-small-provider",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ),
    )
    const providerConfig: ResolvedProviderConfig = {
      apiKey: "provider-key",
      authType: "authorization",
      baseUrl: "https://provider.example",
      name: "azure-openai",
      type: "anthropic",
    }
    modelMappings = {
      "gpt-small-model": "azure-openai/gpt-small-provider",
    }
    providerMessagesHandlerDependencies.resolveProviderConfig = (provider) =>
      Promise.resolve(provider === "azure-openai" ? providerConfig : null)
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch

    try {
      const response = await createApp().request("/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-beta": "warmup-beta",
        },
        body: JSON.stringify(createPayload()),
      })

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe("https://provider.example/v1/messages")
      const upstreamPayload = JSON.parse(init?.body as string) as {
        model: string
      }
      expect(upstreamPayload.model).toBe("gpt-small-provider")
      expect(findEndpointModel).not.toHaveBeenCalled()
    } finally {
      ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
    }
  })

  test("rejects a disallowed warmup fallback before selecting a flow", async () => {
    smallModel = "Claude-Haiku-4"

    const response = await createApp().request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "warmup-beta",
      },
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(400)
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).not.toHaveBeenCalled()
    expect(handleWithChatCompletions).not.toHaveBeenCalled()
  })

  test("uses the configured warmup model for security-monitor-shaped requests", async () => {
    selectedModel = {
      id: "gpt-small-model",
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
    expect(findEndpointModel).toHaveBeenCalledWith("gpt-small-model")
  })

  test("prefers dispatch-provided session, request, and subagent context", async () => {
    selectedModel = {
      id: "gpt-messages-model",
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
})
