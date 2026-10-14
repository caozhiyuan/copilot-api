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

import { compactSummaryPromptStart, compactTextOnlyGuard } from "~/lib/compact"
import { createFallbackModel } from "~/lib/provider-model"

const actualStateModule = await import("~/lib/state")
const actualConfigModule = await import("~/lib/config")
const actualModelsModule = await import("~/lib/models")
const actualUtilsModule = await import("~/lib/utils")
const { responsesUtilsDependencies } = await import("~/routes/responses/utils")
const actualProviderMessagesModule = await import(
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
let claudeAutoModel: string | undefined
let restoreClaudeAutoModel = () => {}
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
  // Restore this re-exported getter so other suites keep the real config lookup.
  const claudeAutoModelLookup = spyOn(
    actualConfigModule,
    "getClaudeAutoModel",
  ).mockImplementation(() => claudeAutoModel)
  restoreClaudeAutoModel = () => claudeAutoModelLookup.mockRestore()
  const modelLookup = spyOn(
    actualModelsModule,
    "findEndpointModel",
  ).mockImplementation(findEndpointModel)
  restoreModelLookup = () => modelLookup.mockRestore()

  state.verbose = false
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
  restoreClaudeAutoModel()
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
  test.each<{
    name: string
    userAgent?: string
    tools?: AnthropicMessagesPayload["tools"]
    outputConfig?: AnthropicMessagesPayload["output_config"]
    expectedEffort?: NonNullable<
      AnthropicMessagesPayload["output_config"]
    >["effort"]
  }>([
    {
      name: "Claude without tools overrides max",
      userAgent: "claude-cli/2.1.258",
      outputConfig: { effort: "max" },
      expectedEffort: "low",
    },
    {
      name: "mixed-case Claude with empty tools overrides high",
      userAgent: "Claude-Code/2.1.258",
      tools: [],
      outputConfig: { effort: "high" },
      expectedEffort: "low",
    },
    {
      name: "embedded Claude without output config adds low",
      userAgent: "vscode_claude_code/2.1.258 (external, sdk-ts)",
      expectedEffort: "low",
    },
    {
      name: "Claude keeps the output format when adding low",
      userAgent: "claude-cli/2.1.258",
      outputConfig: {
        format: { type: "json_schema", schema: { type: "object" } },
      },
      expectedEffort: "low",
    },
    {
      name: "Claude with tools keeps max",
      userAgent: "claude-cli/2.1.258",
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
      outputConfig: { effort: "max" },
      expectedEffort: "max",
    },
    {
      name: "other clients keep max",
      userAgent: "opencode/1.0.0",
      outputConfig: { effort: "max" },
      expectedEffort: "max",
    },
    {
      name: "missing user agent keeps max",
      outputConfig: { effort: "max" },
      expectedEffort: "max",
    },
    {
      name: "empty user agent keeps output config absent",
      userAgent: "",
    },
  ])(
    "applies Claude effort policy before every upstream flow: $name",
    async ({ userAgent, tools, outputConfig, expectedEffort }) => {
      for (const [endpoint, flow] of [
        ["/v1/messages", handleWithMessagesApi],
        ["/responses", handleWithResponsesApi],
        ["/chat/completions", handleWithChatCompletions],
      ] as const) {
        selectedModel = {
          id: "upstream-model",
          supported_endpoints: [endpoint],
        }
        const headers: Record<string, string> = {
          "content-type": "application/json",
        }
        if (userAgent !== undefined) headers["user-agent"] = userAgent
        const response = await createApp().request("/", {
          method: "POST",
          headers,
          body: JSON.stringify(
            createPayload({ tools, output_config: outputConfig }),
          ),
        })

        expect(response.status).toBe(200)
        expect(flow).toHaveBeenCalledTimes(1)
        const forwardedPayload = flow.mock.calls[0][1]
        expect(forwardedPayload.output_config).toEqual(
          expectedEffort ?
            { ...outputConfig, effort: expectedEffort }
          : outputConfig,
        )
        expect(forwardedPayload.tools).toEqual(tools)
      }
    },
  )

  test.each([
    { endpoint: "/v1/messages", responseBody: "messages" },
    { endpoint: "/responses", responseBody: "responses" },
    { endpoint: "/chat/completions", responseBody: "chat" },
  ])(
    "appends a continuation for a mapped Claude model before forwarding to %j",
    async ({ endpoint, responseBody }) => {
      modelMappings = { primary: "claude-sonnet-5" }
      selectedModel = {
        id: "claude-sonnet-5",
        supported_endpoints: [endpoint],
      }
      const messages: AnthropicMessagesPayload["messages"] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "partial answer" },
      ]
      const response = await createApp().request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload({ model: "primary", messages })),
      })

      expect(response.status).toBe(200)
      expect(await response.text()).toBe(responseBody)
      const flow =
        responseBody === "messages" ? handleWithMessagesApi
        : responseBody === "responses" ? handleWithResponsesApi
        : handleWithChatCompletions
      expect(flow).toHaveBeenCalledTimes(1)
      expect(flow.mock.calls[0][1].messages).toEqual([
        ...messages,
        {
          role: "user",
          content: [{ type: "text", text: "Please continue." }],
        },
      ])
    },
  )

  test.each<{
    model: string
    resolvedModel?: string
    messages: AnthropicMessagesPayload["messages"]
  }>([
    { model: "claude-sonnet-5", messages: [] },
    {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hello" }],
    },
    {
      model: "claude-sonnet-5",
      messages: [
        { role: "assistant", content: "previous answer" },
        { role: "user", content: "Please continue." },
      ],
    },
    {
      model: "gpt-5.4",
      messages: [{ role: "assistant", content: "partial answer" }],
    },
    {
      model: "claude-sonnet-5",
      resolvedModel: "gpt-5.4",
      messages: [{ role: "assistant", content: "partial answer" }],
    },
  ])(
    "preserves messages when the resolved conversation does not need a Claude continuation: %j",
    async ({ model, resolvedModel, messages }) => {
      modelMappings = resolvedModel ? { [model]: resolvedModel } : {}
      selectedModel = {
        id: resolvedModel ?? model,
        supported_endpoints: ["/v1/messages"],
      }
      const response = await createApp().request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload({ model, messages })),
      })

      expect(response.status).toBe(200)
      expect(handleWithMessagesApi).toHaveBeenCalledTimes(1)
      expect(handleWithMessagesApi.mock.calls[0][1].messages).toEqual(messages)
    },
  )

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

  test.each<{
    name: string
    system: AnthropicMessagesPayload["system"]
  }>([
    {
      name: "string",
      system:
        "You are a security monitor for autonomous AI coding agents. Check the changes.",
    },
    {
      name: "text block array",
      system: [
        {
          type: "text",
          text: "You are a security monitor for autonomous AI coding agents. Check the changes.",
        },
      ],
    },
    {
      name: "text block array with a preceding billing header",
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.158.c0c; cc_entrypoint=cli; cch=6fb32;",
        },
        {
          type: "text",
          text: "You are a security monitor for autonomous AI coding agents. Check the changes.",
        },
      ],
    },
  ])(
    "selects the Claude auto model for system as $name",
    async ({ system }) => {
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
            system,
          }),
        ),
      })

      expect(response.status).toBe(200)
      expect(await response.text()).toBe("messages")
      expect(findEndpointModel).toHaveBeenCalledTimes(1)
      expect(findEndpointModel).toHaveBeenCalledWith("auto-model")
    },
  )

  test("routes the default Claude auto model to the Codex provider", async () => {
    claudeAutoModel = "codex-auto-review"
    modelMappings = { ...actualConfigModule.defaultConfig.modelMappings }
    const providerResolver = spyOn(
      actualProviderMessagesModule.providerMessagesHandlerDependencies,
      "resolveProviderConfig",
    ).mockResolvedValue({
      name: "codex",
      type: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      apiKey: "test-token",
      authType: "oauth2",
    })
    const providerHandler = spyOn(
      actualProviderMessagesModule,
      "handleProviderMessagesForProvider",
    ).mockResolvedValue(new Response("codex"))
    try {
      const response = await createApp().request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createPayload({
            stop_sequences: ["</block>"],
            system:
              "You are a security monitor for autonomous AI coding agents. Check the changes.",
          }),
        ),
      })

      expect(await response.text()).toBe("codex")
      expect(providerResolver).toHaveBeenCalledWith("codex")
      expect(providerHandler).toHaveBeenCalledTimes(1)
      const { payload, provider } = providerHandler.mock.calls[0][1]
      expect(provider).toBe("codex")
      expect(payload.model).toBe("codex-auto-review")
      expect(findEndpointModel).not.toHaveBeenCalled()
    } finally {
      providerResolver.mockRestore()
      providerHandler.mockRestore()
    }
  })

  test.each([
    { skipModelMapping: false, expected: "gpt-6-luna" },
    { skipModelMapping: true, expected: "codex-auto-review" },
  ])(
    "resolves the Claude auto model with skipModelMapping=$skipModelMapping",
    async ({ skipModelMapping, expected }) => {
      claudeAutoModel = "codex-auto-review"
      modelMappings = { "codex-auto-review": "gpt-6-luna" }
      selectedModel = { id: expected, supported_endpoints: ["/v1/messages"] }

      const app = new Hono()
      app.post("/", (c) =>
        handleCompletionPayload(
          c,
          createPayload({
            stop_sequences: ["</block>"],
            system:
              "You are a security monitor for autonomous AI coding agents. Check the changes.",
          }),
          { skipModelMapping },
        ),
      )
      const response = await app.request("/", { method: "POST" })

      expect(response.status).toBe(200)
      expect(findEndpointModel).toHaveBeenCalledWith(expected)
      expect(handleWithMessagesApi.mock.calls[0][1].model).toBe(expected)
    },
  )

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
})
