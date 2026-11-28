import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { ResolvedProviderConfig } from "~/lib/config"
import type { RequestContext } from "~/lib/http/request-context"
import type { ChatCompletionChunk } from "~/lib/types/chat-completions"
import type {
  GoogleGenerateContentResponse,
  GoogleModelsResponse,
  GooglePart,
} from "~/lib/types/google"
import type {
  ResponseInputItem,
  ResponseOutputFunctionCall,
  ResponseOutputReasoning,
  ResponseStreamEvent,
} from "~/lib/types/responses"

import { createResponsesResult } from "./fixtures/responses"

process.env.COPILOT_API_HOME = mkdtempSync(
  path.join(tmpdir(), "copilot-api-google-endpoint-"),
)
process.env.COPILOT_API_SQLITE_DB_PATH = ":memory:"

const { createServer } = await import("~/server")
const { state } = await import("~/lib/state")
const { requestContext } = await import("~/lib/http/request-context")
const { GatewayPlugins } = await import("~/lib/plugins/gateway-plugins")
const { messagesApiFlowDependencies } = await import(
  "~/routes/messages/api-flows"
)
const { webSearchFlowDependencies } = await import(
  "~/routes/messages/web-search/fulfill"
)
const { encodeAntigravitySignatures, encodeAntigravityToolCallSignature } =
  await import("~/routes/google/antigravity-signatures")
const { googleHandlerDependencies, parseGoogleModelActionPath } = await import(
  "~/routes/google/handler"
)
const { closeUsageStore, getTokenUsageEventsPage } = await import(
  "~/lib/token-usage"
)

const originalCreateChatCompletions =
  messagesApiFlowDependencies.createChatCompletions
const originalCreateResponses = messagesApiFlowDependencies.createResponses
const originalHandleCompletionPayload =
  googleHandlerDependencies.handleCompletionPayload
const originalGetAggregatedModels =
  googleHandlerDependencies.getAggregatedModels
const originalGetMessageApiWebSearchModel =
  googleHandlerDependencies.getMessageApiWebSearchModel
const originalGetProviderConfig = googleHandlerDependencies.getProviderConfig
const originalIsResponsesApiWebSearchEnabled =
  googleHandlerDependencies.isResponsesApiWebSearchEnabled
const originalResolveAlias =
  googleHandlerDependencies.resolveConfiguredProviderModelAlias
const originalResolveProvider = googleHandlerDependencies.resolveProviderConfig
const originalForwardGoogle =
  googleHandlerDependencies.forwardGoogleGenerateContent
const originalSseKeepaliveIntervalMs =
  googleHandlerDependencies.sseKeepaliveIntervalMs
const originalWebSearchCreateResponses =
  webSearchFlowDependencies.createResponses
const originalWebSearchModelGetter =
  webSearchFlowDependencies.getMessageApiWebSearchModel
const originalWebSearchResolveProvider =
  webSearchFlowDependencies.resolveProviderConfig
const originalStateModels = state.models

const createChatCompletions = mock(originalCreateChatCompletions)
const createResponses = mock(originalCreateResponses)
const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const antigravityHeaders = { "user-agent": "antigravity/cli/1.5.16" }

async function* streamEvents(
  items: Array<ServerSentEventMessage>,
): AsyncGenerator<ServerSentEventMessage, void, unknown> {
  await Promise.resolve()
  for (const item of items) {
    yield item
  }
}

function makeOpenAIChunk(
  delta: ChatCompletionChunk["choices"][number]["delta"],
  options: {
    finishReason?: ChatCompletionChunk["choices"][number]["finish_reason"]
    model?: string
    usage?: ChatCompletionChunk["usage"]
  } = {},
): ServerSentEventMessage {
  const chunk: ChatCompletionChunk = {
    id: "chatcmpl-google-test",
    object: "chat.completion.chunk",
    created: 0,
    model: options.model ?? "gemini-4-neon",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: options.finishReason ?? null,
        logprobs: null,
      },
    ],
    ...(options.usage ? { usage: options.usage } : {}),
  }
  return { data: JSON.stringify(chunk) }
}

function parseSseDataEvents(
  body: string,
): Array<GoogleGenerateContentResponse> {
  return body.split(/\r?\n\r?\n/u).flatMap((block) => {
    const dataLines = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
    if (dataLines.length === 0) return []
    return [JSON.parse(dataLines.join("\n")) as GoogleGenerateContentResponse]
  })
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  createChatCompletions.mockReset()
  createResponses.mockReset()
  messagesApiFlowDependencies.createChatCompletions = createChatCompletions
  messagesApiFlowDependencies.createResponses = createResponses
  state.models = originalStateModels
  googleHandlerDependencies.handleCompletionPayload =
    originalHandleCompletionPayload
  googleHandlerDependencies.getAggregatedModels = originalGetAggregatedModels
  googleHandlerDependencies.getMessageApiWebSearchModel =
    originalGetMessageApiWebSearchModel
  googleHandlerDependencies.getProviderConfig = originalGetProviderConfig
  googleHandlerDependencies.isResponsesApiWebSearchEnabled =
    originalIsResponsesApiWebSearchEnabled
  googleHandlerDependencies.resolveConfiguredProviderModelAlias =
    originalResolveAlias
  googleHandlerDependencies.resolveProviderConfig = originalResolveProvider
  googleHandlerDependencies.forwardGoogleGenerateContent = originalForwardGoogle
  googleHandlerDependencies.sseKeepaliveIntervalMs =
    originalSseKeepaliveIntervalMs
  webSearchFlowDependencies.createResponses = originalWebSearchCreateResponses
  webSearchFlowDependencies.getMessageApiWebSearchModel =
    originalWebSearchModelGetter
  webSearchFlowDependencies.resolveProviderConfig =
    originalWebSearchResolveProvider
})

afterEach(async () => {
  messagesApiFlowDependencies.createChatCompletions =
    originalCreateChatCompletions
  messagesApiFlowDependencies.createResponses = originalCreateResponses
  state.models = originalStateModels
  googleHandlerDependencies.handleCompletionPayload =
    originalHandleCompletionPayload
  googleHandlerDependencies.getAggregatedModels = originalGetAggregatedModels
  googleHandlerDependencies.getMessageApiWebSearchModel =
    originalGetMessageApiWebSearchModel
  googleHandlerDependencies.getProviderConfig = originalGetProviderConfig
  googleHandlerDependencies.isResponsesApiWebSearchEnabled =
    originalIsResponsesApiWebSearchEnabled
  googleHandlerDependencies.resolveConfiguredProviderModelAlias =
    originalResolveAlias
  googleHandlerDependencies.resolveProviderConfig = originalResolveProvider
  googleHandlerDependencies.forwardGoogleGenerateContent = originalForwardGoogle
  googleHandlerDependencies.sseKeepaliveIntervalMs =
    originalSseKeepaliveIntervalMs
  webSearchFlowDependencies.createResponses = originalWebSearchCreateResponses
  webSearchFlowDependencies.getMessageApiWebSearchModel =
    originalWebSearchModelGetter
  webSearchFlowDependencies.resolveProviderConfig =
    originalWebSearchResolveProvider
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
})

describe("parseGoogleModelActionPath", () => {
  test("parses Gemini v1beta paths with percent-encoded and namespaced models", () => {
    expect(
      parseGoogleModelActionPath(
        "http://localhost/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
      ),
    ).toEqual({ model: "gemini-4-neon", action: "streamGenerateContent" })

    expect(
      parseGoogleModelActionPath(
        "http://localhost/v1beta1/projects/my-proj/locations/global/publishers/google/models/gemini-4-neon:generateContent",
      ),
    ).toBeNull()

    expect(
      parseGoogleModelActionPath(
        "http://localhost/v1beta/models/openrouter%2Fgemini-4-neon:generateContent",
      ),
    ).toEqual({
      model: "openrouter/gemini-4-neon",
      action: "generateContent",
    })

    expect(
      parseGoogleModelActionPath(
        "http://localhost/v1beta/models/ollama/llama3:8b:generateContent",
      ),
    ).toEqual({ model: "ollama/llama3:8b", action: "generateContent" })

    expect(
      parseGoogleModelActionPath(
        "http://localhost/v1beta/models/models/gemini-4-neon:generateContent",
      ),
    ).toEqual({ model: "gemini-4-neon", action: "generateContent" })

    expect(
      parseGoogleModelActionPath("http://localhost/v1beta/models/no-action"),
    ).toBeNull()

    expect(() =>
      parseGoogleModelActionPath(
        "http://localhost/v1beta/models/%E0%A4%A:generateContent",
      ),
    ).toThrow("Malformed URL-encoded model identifier")
  })
})

describe("Google Gemini /v1beta/models integration via Messages API", () => {
  test("returns 404 for a Vertex inference path", async () => {
    const response = await createServer().request(
      "/v1beta1/projects/demo/locations/global/publishers/google/models/gemini-4-neon:generateContent",
      { method: "POST" },
    )
    expect(response.status).toBe(404)
  })

  test("assigns Antigravity session labels before dispatch and publishes the session ID", async () => {
    const labels = {
      cascade_id: "5fe81afd-2716-4933-8381-072aed9753d4",
      root_cascade_id: "0058a47c-39ed-4dca-91ab-f9ad1e68e524",
      parent_cascade_id: "d7b793bb-3f1d-48cc-a8ee-4d3f44d903fe",
    }
    const agyHeaders = {
      "user-agent":
        "antigravity/cli/1.5.16 (aidev_client; auth_method=gateway)",
    }
    const contexts: Array<RequestContext | undefined> = []
    googleHandlerDependencies.handleCompletionPayload = mock(() => {
      contexts.push(requestContext.getStore())
      return Promise.resolve(new Response(null, { status: 422 }))
    })
    const plugins = new GatewayPlugins(4141)
    const sessionUpdates: Array<string | null> = []
    await plugins.register("session-observer", ({ on }) => {
      on("request.session", ({ sessionId }) => {
        sessionUpdates.push(sessionId)
      })
    })

    try {
      const app = createServer({ plugins })
      const request = async (
        sessionLabels: Record<string, unknown>,
        headers: Record<string, string>,
      ) => {
        const response = await app.request(
          "/v1beta/models/gemini-4-neon:generateContent",
          {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: "Hello" }] }],
              labels: sessionLabels,
            }),
          },
        )
        expect(response.status).toBe(422)
      }

      await request(labels, agyHeaders)
      await request(labels, { "user-agent": "gemini-client/1.0" })
      await request(
        {
          cascade_id: "not-a-uuid",
          root_cascade_id: "",
          parent_cascade_id: 42,
        },
        agyHeaders,
      )
      await request(labels, {
        ...agyHeaders,
        "x-session-affinity": "header-session",
        "x-root-session-id": "header-root",
        "x-parent-session-id": "header-parent",
      })
      await request(labels, {
        ...agyHeaders,
        "x-session-affinity": "proxy-only-session",
      })
      await plugins.flush()

      const emptySession = {
        sessionAffinity: undefined,
        rootSessionId: undefined,
        parentSessionId: undefined,
        subagent: null,
      }
      expect(contexts).toMatchObject([
        {
          sessionAffinity: labels.cascade_id,
          rootSessionId: labels.root_cascade_id,
          parentSessionId: labels.parent_cascade_id,
          subagent: {
            session_id: labels.root_cascade_id,
            agent_id: labels.cascade_id,
            agent_type: "subagent",
          },
        },
        emptySession,
        emptySession,
        {
          sessionAffinity: "header-session",
          rootSessionId: "header-root",
          parentSessionId: "header-parent",
        },
        {
          sessionAffinity: "proxy-only-session",
          rootSessionId: undefined,
          parentSessionId: undefined,
          subagent: null,
        },
      ])
      expect(sessionUpdates).toEqual([labels.cascade_id])
    } finally {
      await plugins.close()
    }
  })

  test("end-to-end multi-turn SSE round-trip preserves Copilot reasoning_opaque as Gemini thoughtSignature", async () => {
    const app = createServer()
    const opaqueToken = Buffer.from("gemini-4-neon-encrypted-thought").toString(
      "base64",
    )

    // Turn 1: Copilot returns reasoning_text, reasoning_opaque, and a tool call
    createChatCompletions.mockImplementationOnce(() =>
      Promise.resolve(
        streamEvents([
          makeOpenAIChunk({ reasoning_text: "Let me read README.md." }),
          makeOpenAIChunk({
            reasoning_opaque: opaqueToken,
            tool_calls: [
              {
                index: 0,
                id: "call_read_1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          }),
          makeOpenAIChunk(
            {},
            {
              finishReason: "tool_calls",
              usage: {
                prompt_tokens: 40,
                completion_tokens: 15,
                total_tokens: 55,
              },
            },
          ),
          { data: "[DONE]" },
        ]),
      ),
    )

    const turn1Res = await app.request(
      "/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent":
            "antigravity/cli/1.5.15 (aidev_client; auth_method=gateway)",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Read README.md" }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: "read_file",
                  parametersJsonSchema: {
                    type: "object",
                    properties: { path: { type: "string" } },
                    required: ["path"],
                  },
                },
              ],
            },
          ],
        }),
      },
    )

    expect(turn1Res.status).toBe(200)
    expect(turn1Res.headers.get("content-type")).toContain("text/event-stream")
    const turn1Events = parseSseDataEvents(await turn1Res.text())
    const thoughtPart = turn1Events[0]?.candidates?.[0]?.content?.parts?.[0]
    const callPart = turn1Events[1]?.candidates?.[0]?.content?.parts?.[0]
    expect(thoughtPart).toEqual({
      text: "Let me read README.md.",
      thought: true,
    })
    expect(callPart).toEqual({
      functionCall: {
        id: "call_read_1",
        name: "read_file",
        args: { path: "README.md" },
      },
      thoughtSignature: encodeAntigravityToolCallSignature(
        "call_read_1",
        opaqueToken,
      ),
    })
    expect(turn1Events[2]?.candidates?.[0]?.finishReason).toBe("STOP")

    // Turn 2: Antigravity CLI replays functionCall + thoughtSignature + functionResponse without id fields
    createChatCompletions.mockImplementationOnce((payload) => {
      const assistantMsg = payload.messages.find((m) => m.role === "assistant")
      expect(assistantMsg?.reasoning_opaque).toBe(opaqueToken)
      expect(assistantMsg?.reasoning_text).toBe("Let me read README.md.")
      expect(assistantMsg?.tool_calls?.[0]?.id).toBe("call_read_1")
      const toolMsg = payload.messages.find((m) => m.role === "tool")
      expect(toolMsg?.tool_call_id).toBe("call_read_1")
      expect(toolMsg?.content).toBe("# Copilot API")

      return Promise.resolve({
        id: "chatcmpl-turn2",
        object: "chat.completion" as const,
        created: 0,
        model: "gemini-4-neon",
        choices: [
          {
            index: 0,
            message: { role: "assistant" as const, content: "Done reading." },
            logprobs: null,
            finish_reason: "stop" as const,
          },
        ],
        usage: {
          prompt_tokens: 70,
          completion_tokens: 10,
          total_tokens: 80,
        },
      })
    })

    const replayedCallPart = {
      functionCall: {
        name: callPart!.functionCall!.name,
        args: callPart!.functionCall!.args,
      },
      thoughtSignature: callPart!.thoughtSignature,
    }
    const turn2Res = await app.request(
      "/v1beta/models/gemini-4-neon:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: "Read README.md" }] },
            { role: "model", parts: [thoughtPart, replayedCallPart] },
            {
              role: "user",
              parts: [
                {
                  functionResponse: {
                    name: "read_file",
                    response: { output: "# Copilot API" },
                  },
                },
              ],
            },
          ],
        }),
      },
    )

    expect(turn2Res.status).toBe(200)
    const turn2Body = (await turn2Res.json()) as GoogleGenerateContentResponse
    expect(turn2Body.candidates?.[0]?.content?.parts).toEqual([
      { text: "Done reading." },
    ])
    expect(turn2Body.usageMetadata?.totalTokenCount).toBe(80)

    const usageEvents = await getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "today",
    })
    expect(usageEvents.items).toHaveLength(2)
    expect(
      usageEvents.items.every((item) => item.endpoint === "generate_content"),
    ).toBe(true)
  })

  test("returns JSON array for :streamGenerateContent without alt=sse", async () => {
    const app = createServer()
    createChatCompletions.mockImplementationOnce(() =>
      Promise.resolve(
        streamEvents([
          makeOpenAIChunk({ content: "Hello " }),
          makeOpenAIChunk({ content: "world" }),
          makeOpenAIChunk(
            {},
            {
              finishReason: "stop",
              usage: {
                prompt_tokens: 10,
                completion_tokens: 4,
                total_tokens: 14,
              },
            },
          ),
          { data: "[DONE]" },
        ]),
      ),
    )

    const res = await app.request(
      "/v1beta/models/gemini-4-neon:streamGenerateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Say hi" }] }],
        }),
      },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(res.headers.get("transfer-encoding")).toBeNull()
    expect(res.headers.get("cache-control")).toBeNull()
    expect(res.headers.get("connection")).toBeNull()
    expect(res.headers.get("x-trace-id")).toBeTruthy()
    const chunks = (await res.json()) as Array<GoogleGenerateContentResponse>
    expect(
      chunks.map((c) => c.candidates?.[0]?.content?.parts?.[0]?.text),
    ).toEqual(["Hello ", "world", undefined])
    expect(chunks.at(-1)?.candidates?.[0]?.finishReason).toBe("STOP")
  })

  test("acknowledges POST /v1beta:* telemetry pings and enforces x-goog-api-key auth", async () => {
    const app = createServer({ getApiKeys: () => ["secret-key"] })

    const unauth = await app.request("/v1beta:recordTelemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    })
    expect(unauth.status).toBe(401)

    const authed = await app.request("/v1beta:recordTelemetry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": "secret-key",
      },
      body: JSON.stringify({ events: [] }),
    })
    expect(authed.status).toBe(200)
    expect(await authed.json()).toEqual({})
  })

  test("lists models on GET /v1beta/models without being hijacked by /:provider/models", async () => {
    const app = createServer()
    googleHandlerDependencies.getAggregatedModels = mock(() =>
      Promise.resolve([
        {
          id: "gemini-4-neon",
          object: "model",
          display_name: "Gemini 4 Neon",
          context_window: 1_000_000,
          max_output_tokens: 65_536,
        },
        {
          id: "claude-opus-4-6",
          object: "model",
          input_limit: 200_000,
        },
      ]),
    )

    const res = await app.request("/v1beta/models")
    expect(res.status).toBe(200)
    const body = (await res.json()) as GoogleModelsResponse
    expect(body).toEqual({
      models: [
        {
          name: "models/gemini-4-neon",
          displayName: "Gemini 4 Neon",
          inputTokenLimit: 1_000_000,
          outputTokenLimit: 65_536,
          supportedGenerationMethods: [
            "generateContent",
            "streamGenerateContent",
          ],
        },
        {
          name: "models/claude-opus-4-6",
          displayName: "claude-opus-4-6",
          inputTokenLimit: 200_000,
          supportedGenerationMethods: [
            "generateContent",
            "streamGenerateContent",
          ],
        },
      ],
    })
  })

  test("lists models with multiple efforts as variants for every user agent", async () => {
    const base = "gpt-5.4"
    const getModels = mock(() =>
      Promise.resolve([
        { id: `${base}-high`, object: "model", display_name: "High preset" },
        {
          id: base,
          object: "model",
          display_name: "GPT-5.4",
          reasoning_efforts: ["low", "medium", "high", "max", "ultra"],
        },
        {
          id: `${base}-medium`,
          object: "model",
          display_name: "Medium preset",
        },
        { id: "fixed-model", object: "model", reasoning_efforts: ["high"] },
      ]),
    )
    googleHandlerDependencies.getAggregatedModels = getModels
    const handleCompletion = mock<typeof originalHandleCompletionPayload>(
      (_c, payload) =>
        Promise.resolve(
          Response.json({
            id: "msg_effort",
            type: "message",
            role: "assistant",
            model: payload.model,
            content: [{ type: "text", text: "OK" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 2, output_tokens: 1 },
          }),
        ),
    )
    googleHandlerDependencies.handleCompletionPayload = handleCompletion
    const app = createServer()

    const response = await app.request("/v1beta/models")
    const catalog = (await response.json()) as GoogleModelsResponse
    expect(
      catalog.models?.map(({ name, displayName }) => [name, displayName]),
    ).toEqual([
      [`models/${base}-medium`, "Medium preset"],
      [`models/${base}-low`, "GPT-5.4 (Low)"],
      [`models/${base}-high`, "High preset"],
      [`models/${base}-max`, "GPT-5.4 (Max)"],
      ["models/fixed-model", "fixed-model"],
    ])
    const agyResponse = await app.request("/v1beta/models", {
      headers: antigravityHeaders,
    })
    expect(await agyResponse.json()).toEqual(catalog)

    const makeRequest = (
      model: string,
      clientHeaders: Record<string, string> = {},
    ) =>
      app.request(`/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", ...clientHeaders },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: {
            thinkingConfig: { includeThoughts: false, thinkingBudget: 0 },
          },
        }),
      })

    expect((await makeRequest(`${base}-max`)).status).toBe(200)
    expect(handleCompletion.mock.calls[0]?.[1]).toMatchObject({
      model: base,
      output_config: { effort: "max" },
    })
    expect(handleCompletion.mock.calls[0]?.[1].thinking).toBeUndefined()
    expect((await makeRequest(`${base}-high`)).status).toBe(200)
    expect(handleCompletion.mock.calls[1]?.[1].model).toBe(`${base}-high`)
    const otherClient = await makeRequest(`${base}-max`, {
      "user-agent": "google-genai/test",
    })
    expect(otherClient.status).toBe(200)
    expect(handleCompletion.mock.calls[2]?.[1]).toMatchObject({
      model: base,
      output_config: { effort: "max" },
    })
    expect(getModels).toHaveBeenCalledTimes(2)

    state.models = { object: "list", data: [] }
    expect((await makeRequest(`${base}-low`)).status).toBe(200)
    expect(handleCompletion.mock.calls[3]?.[1]).toMatchObject({
      model: base,
      output_config: { effort: "low" },
    })
    expect((await makeRequest(base)).status).toBe(200)
    expect(handleCompletion.mock.calls[4]?.[1].model).toBe(base)
    expect(getModels).toHaveBeenCalledTimes(3)
  })

  test("advertises media-capable models with aliases and resolves their original IDs", async () => {
    const base = "codex/gpt-6.2-astra"
    const alias = "codex/my-gemini-gpt-6.2-astra"
    const provider: ResolvedProviderConfig = {
      name: "codex",
      type: "openai-responses",
      baseUrl: "https://example.com",
      authType: "authorization",
      apiKey: "upstream-key",
      models: {
        "no-pdf": { supportPdf: false },
      },
    }
    googleHandlerDependencies.getProviderConfig = mock((name) =>
      name === provider.name ? provider : null,
    )
    const imageModel = { object: "model", input_modalities: ["text", "image"] }
    const textModel = { object: "model", input_modalities: ["text"] }
    const getModels = mock(() =>
      Promise.resolve([
        {
          ...imageModel,
          id: base,
          display_name: "GPT-6.2 Astra (codex)",
          reasoning_efforts: ["low", "medium", "max"],
        },
        { ...imageModel, id: `${base}-low` },
        {
          ...imageModel,
          id: "document-model",
          capabilities: {
            limits: { vision: { supported_media_types: ["application/pdf"] } },
          },
        },
        { ...imageModel, id: "codex/no-pdf" },
        { ...textModel, id: "codex/text-only" },
        { ...imageModel, id: "codex/reserved" },
        { ...textModel, id: "codex/my-gemini-reserved" },
        {
          ...imageModel,
          id: "codex/mixed",
          reasoning_efforts: ["low", "high"],
        },
        { ...textModel, id: "codex/mixed-high" },
        { ...imageModel, id: "codex/organic-low" },
        {
          ...imageModel,
          id: "codex/my-gemini-organic",
          reasoning_efforts: ["low", "high"],
        },
      ]),
    )
    googleHandlerDependencies.getAggregatedModels = getModels
    const handleCompletion = mock<typeof originalHandleCompletionPayload>(
      (_c, payload) =>
        Promise.resolve(
          Response.json({
            id: "msg_alias",
            type: "message",
            role: "assistant",
            model: payload.model,
            content: [{ type: "text", text: "OK" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 2, output_tokens: 1 },
          }),
        ),
    )
    googleHandlerDependencies.handleCompletionPayload = handleCompletion
    const app = createServer()
    const generate = (model: string, action = "generateContent") =>
      app.request(`/v1beta/models/${model}:${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
        }),
      })

    state.models = { object: "list", data: [] }
    expect((await generate(`${alias}-max`)).status).toBe(200)
    expect(handleCompletion.mock.calls[0]?.[1]).toMatchObject({
      model: base,
      output_config: { effort: "max" },
    })
    expect(getModels).toHaveBeenCalledTimes(1)

    const response = await app.request("/v1beta/models")
    expect(response.status).toBe(200)
    const { models } = (await response.json()) as GoogleModelsResponse
    expect(models?.map(({ name }) => name)).toEqual([
      `models/${alias}-medium`,
      `models/${alias}-low`,
      `models/${alias}-max`,
      "models/my-gemini-document-model",
      "models/codex/no-pdf",
      "models/codex/text-only",
      "models/codex/reserved",
      "models/codex/my-gemini-reserved",
      "models/codex/mixed-low",
      "models/codex/mixed-high",
      "models/codex/organic-low",
      "models/codex/my-gemini-organic-low",
      "models/codex/my-gemini-organic-high",
    ])
    expect(models?.[0]?.displayName).toBe("GPT-6.2 Astra (codex) (Medium)")
    expect(models?.[3]?.displayName).toBe("document-model")

    expect((await generate(alias, "streamGenerateContent")).status).toBe(200)
    expect(handleCompletion.mock.calls[1]?.[1].model).toBe(base)
    expect((await generate(`${base}-max`)).status).toBe(200)
    expect(handleCompletion.mock.calls[2]?.[1]).toMatchObject({
      model: base,
      output_config: { effort: "max" },
    })
    expect((await generate("my-gemini-document-model")).status).toBe(200)
    expect(handleCompletion.mock.calls[3]?.[1].model).toBe("document-model")
    expect((await generate("codex/my-gemini-reserved")).status).toBe(200)
    expect(handleCompletion.mock.calls[4]?.[1].model).toBe(
      "codex/my-gemini-reserved",
    )
    expect(getModels).toHaveBeenCalledTimes(2)

    provider.agentsModels = ["gpt-6.2-astra"]
    const selected = await app.request("/v1beta/models", {
      headers: antigravityHeaders,
    })
    const selectedCatalog = (await selected.json()) as GoogleModelsResponse
    expect(selectedCatalog.models?.map(({ name }) => name)).toEqual([
      `models/${alias}-medium`,
      `models/${alias}-max`,
      "models/my-gemini-document-model",
    ])
    expect((await generate(`${alias}-low`)).status).toBe(200)
    expect(handleCompletion.mock.calls[5]?.[1].model).toBe(`${base}-low`)

    provider.agentsModels = []
    const hidden = await app.request("/v1beta/models")
    const hiddenCatalog = (await hidden.json()) as GoogleModelsResponse
    expect(hiddenCatalog.models?.map(({ name }) => name)).toEqual([
      "models/my-gemini-document-model",
    ])
    expect((await generate(`${alias}-max`)).status).toBe(200)
    expect(handleCompletion.mock.calls[6]?.[1]).toMatchObject({
      model: base,
      output_config: { effort: "max" },
    })
  })

  test("forwards the selected Antigravity level to a native Google model", async () => {
    const provider: ResolvedProviderConfig = {
      name: "mygoogle",
      type: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      authType: "x-goog-api-key",
      apiKey: "upstream-key",
    }
    const base = "mygoogle/gemini-4-neon"
    googleHandlerDependencies.getProviderConfig = mock(() => provider)
    googleHandlerDependencies.getAggregatedModels = mock(() =>
      Promise.resolve([
        { id: base, object: "model", display_name: "Gemini 4 Neon" },
        {
          id: "mygoogle/gemini-4-argon",
          object: "model",
          display_name: "Gemini 4 Argon",
        },
      ]),
    )
    const resolveAlias = mock<typeof originalResolveAlias>(() =>
      Promise.resolve({ provider: provider.name, model: "gemini-4-neon" }),
    )
    googleHandlerDependencies.resolveConfiguredProviderModelAlias = resolveAlias
    googleHandlerDependencies.resolveProviderConfig = mock(() =>
      Promise.resolve(provider),
    )
    const forward = mock<typeof originalForwardGoogle>(() =>
      Promise.resolve(
        Response.json({ candidates: [{ finishReason: "STOP" }] }),
      ),
    )
    googleHandlerDependencies.forwardGoogleGenerateContent = forward
    const app = createServer()
    const response = await app.request("/v1beta/models", {
      headers: antigravityHeaders,
    })
    const catalog = (await response.json()) as GoogleModelsResponse
    expect(catalog.models?.map((model) => model.name)).toEqual([
      `models/${base}-medium`,
      `models/${base}-low`,
      `models/${base}-high`,
      `models/${base}-xhigh`,
      "models/mygoogle/gemini-4-argon-medium",
      "models/mygoogle/gemini-4-argon-low",
      "models/mygoogle/gemini-4-argon-high",
    ])
    const generation = await app.request(
      `/v1beta/models/${base}-xhigh:generateContent`,
      {
        method: "POST",
        headers: { ...antigravityHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: {
            temperature: 0.7,
            thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 },
          },
        }),
      },
    )
    expect(generation.status).toBe(200)
    expect(resolveAlias.mock.calls[0]?.[0]).toBe(base)
    expect(forward.mock.calls[0]?.[1]).toBe("gemini-4-neon")
    expect(forward.mock.calls[0]?.[2].generationConfig).toEqual({
      temperature: 0.7,
      thinkingConfig: { includeThoughts: true, thinkingLevel: "XHIGH" },
    })
  })

  test.each([
    { upstreamFormat: "json", clientFormat: "json" },
    { upstreamFormat: "sse", clientFormat: "sse" },
    { upstreamFormat: "sse", clientFormat: "array" },
    { upstreamFormat: "array", clientFormat: "sse" },
    { upstreamFormat: "array", clientFormat: "array" },
  ] as const)(
    "passes native Google $upstreamFormat through as $clientFormat",
    async ({ upstreamFormat, clientFormat }) => {
      const app = createServer()
      const googleProvider: ResolvedProviderConfig = {
        name: "mygoogle",
        type: "google",
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "upstream-key",
        authType: "x-goog-api-key",
      }
      googleHandlerDependencies.resolveConfiguredProviderModelAlias = mock(() =>
        Promise.resolve({ provider: "mygoogle", model: "gemini-4-argon" }),
      )
      googleHandlerDependencies.resolveProviderConfig = mock(() =>
        Promise.resolve(googleProvider),
      )

      const nativeResponse: GoogleGenerateContentResponse = {
        responseId: "g-1",
        candidates: [
          {
            index: 0,
            content: {
              role: "model",
              parts: [{ text: "Native reply", thoughtSignature: "RAW_SIG" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 10,
          totalTokenCount: 30,
        },
      }
      const upstream =
        upstreamFormat === "sse" ?
          new Response(`data: ${JSON.stringify(nativeResponse)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        : Response.json(
            upstreamFormat === "array" ? [nativeResponse] : nativeResponse,
          )
      googleHandlerDependencies.forwardGoogleGenerateContent = mock(() =>
        Promise.resolve(upstream),
      )

      const action =
        clientFormat === "json" ? "generateContent" : "streamGenerateContent"
      const query = clientFormat === "sse" ? "?alt=sse" : ""
      const res = await app.request(
        `/v1beta/models/mygoogle/gemini-4-argon:${action}${query}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "Hello" }] }],
          }),
        },
      )
      expect(res.status).toBe(200)
      const body =
        clientFormat === "sse" ?
          parseSseDataEvents(await res.text())
        : await res.json()
      expect(body).toEqual(
        clientFormat === "json" ? nativeResponse : [nativeResponse],
      )
    },
  )

  test("returns proper Google error responses for invalid paths, actions, JSON, and mismatched responses", async () => {
    const app = createServer()

    const badAction = await app.request(
      "/v1beta/models/gemini-4-neon:countTokens",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [] }),
      },
    )
    expect(badAction.status).toBe(400)
    expect(await badAction.json()).toMatchObject({
      error: { code: 400, status: "INVALID_ARGUMENT" },
    })

    const noAction = await app.request("/v1beta/models/gemini-4-neon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(noAction.status).toBe(404)

    const badJson = await app.request(
      "/v1beta/models/gemini-4-neon:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-valid-json",
      },
    )
    expect(badJson.status).toBe(400)

    const emptyContents = await app.request(
      "/v1beta/models/gemini-4-neon:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [] }),
      },
    )
    expect(emptyContents.status).toBe(400)

    // Non-streaming request receiving SSE stream -> 502 without leaked SSE headers
    googleHandlerDependencies.handleCompletionPayload = mock((c: Context) =>
      Promise.resolve(
        streamSSE(c, async (stream) => {
          await stream.writeSSE({ data: "{}" })
        }),
      ),
    )
    const unexpectedStream = await app.request(
      "/v1beta/models/gemini-4-neon:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    )
    expect(unexpectedStream.status).toBe(502)
    expect(unexpectedStream.headers.get("content-type")).toContain(
      "application/json",
    )
    expect(unexpectedStream.headers.get("transfer-encoding")).toBeNull()
    expect(unexpectedStream.headers.get("cache-control")).toBeNull()
    expect(unexpectedStream.headers.get("connection")).toBeNull()

    // Streaming request receiving non-streaming JSON -> wrapped as SSE or JSON array
    const anthropicJson = {
      id: "msg_sync",
      type: "message",
      role: "assistant",
      model: "gemini-4-neon",
      content: [{ type: "text", text: "Sync fallback" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 2 },
    }
    googleHandlerDependencies.handleCompletionPayload = mock(() =>
      Promise.resolve(Response.json(anthropicJson)),
    )
    const syncAsSse = await app.request(
      "/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    )
    expect(syncAsSse.status).toBe(200)
    expect(
      parseSseDataEvents(await syncAsSse.text())[0]?.candidates?.[0]?.content
        ?.parts,
    ).toEqual([{ text: "Sync fallback" }])

    // Upstream non-OK response passed through
    googleHandlerDependencies.handleCompletionPayload = mock(() =>
      Promise.resolve(
        Response.json(
          { error: { message: "Rate limited" } },
          { status: 429, headers: { "retry-after": "5" } },
        ),
      ),
    )
    const rateLimited = await app.request(
      "/v1beta/models/gemini-4-neon:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    )
    expect(rateLimited.status).toBe(429)
    expect(rateLimited.headers.get("retry-after")).toBe("5")

    // Streaming request without alt=sse receiving non-streaming JSON -> JSON array
    googleHandlerDependencies.handleCompletionPayload = mock(() =>
      Promise.resolve(Response.json(anthropicJson)),
    )
    const syncAsArray = await app.request(
      "/v1beta/models/gemini-4-neon:streamGenerateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    )
    expect(syncAsArray.status).toBe(200)
    expect(
      ((await syncAsArray.json()) as Array<GoogleGenerateContentResponse>)[0]
        ?.candidates?.[0]?.content?.parts,
    ).toEqual([{ text: "Sync fallback" }])

    // Streaming request without alt=sse where stream immediately errors -> HTTP 502 error
    googleHandlerDependencies.handleCompletionPayload = mock(() =>
      Promise.resolve(
        new Response(
          `data: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      ),
    )
    const failedArray = await app.request(
      "/v1beta/models/gemini-4-neon:streamGenerateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    )
    expect(failedArray.status).toBe(502)
    expect(await failedArray.json()).toMatchObject({
      error: { code: 502, message: "boom", status: "INTERNAL" },
    })

    // Non-Anthropic JSON returned by Messages API -> 502
    googleHandlerDependencies.handleCompletionPayload = mock(() =>
      Promise.resolve(Response.json({ unexpected: true })),
    )
    const invalidBody = await app.request(
      "/v1beta/models/gemini-4-neon:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    )
    expect(invalidBody.status).toBe(502)

    // Unexpected thrown errors are forwarded by googleRoutes catch blocks
    googleHandlerDependencies.getAggregatedModels = mock(() =>
      Promise.reject(new Error("catalog unavailable")),
    )
    const listErr = await app.request("/v1beta/models")
    expect(listErr.status).toBe(500)

    googleHandlerDependencies.handleCompletionPayload = mock(() =>
      Promise.reject(new Error("unexpected crash")),
    )
    const postErr = await app.request(
      "/v1beta/models/gemini-4-neon:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    )
    expect(postErr.status).toBe(500)
  })

  test("forwards native Google provider HTTP errors", async () => {
    const app = createServer()
    const googleProvider: ResolvedProviderConfig = {
      name: "mygoogle",
      type: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "upstream-key",
      authType: "x-goog-api-key",
    }
    googleHandlerDependencies.resolveConfiguredProviderModelAlias = mock(() =>
      Promise.resolve({ provider: "mygoogle", model: "gemini-4-argon" }),
    )
    googleHandlerDependencies.resolveProviderConfig = mock(() =>
      Promise.resolve(googleProvider),
    )

    googleHandlerDependencies.forwardGoogleGenerateContent = mock(() =>
      Promise.resolve(
        Response.json(
          {
            error: { code: 503, message: "overloaded", status: "UNAVAILABLE" },
          },
          { status: 503 },
        ),
      ),
    )
    const errRes = await app.request(
      "/v1beta/models/mygoogle/gemini-4-argon:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    )
    expect(errRes.status).toBe(503)
  })

  test("returns non-2xx and records error outcome on mid-stream failure in buffered JSON array mode", async () => {
    const endedEvents: Array<{ status: number; outcome: string }> = []
    const plugins = {
      enabled: true,
      publish: (event: string, payload: unknown) => {
        if (event === "request.end") {
          endedEvents.push(payload as { status: number; outcome: string })
        }
      },
    }
    const app = createServer({
      plugins: plugins as Parameters<typeof createServer>[0] extends (
        { plugins?: infer P }
      ) ?
        P
      : never,
    })

    // 1. Translated Messages stream emits partial text then errors mid-stream
    googleHandlerDependencies.handleCompletionPayload = mock(() =>
      Promise.resolve(
        new Response(
          [
            `data: ${JSON.stringify({
              type: "message_start",
              message: {
                id: "msg_partial",
                type: "message",
                role: "assistant",
                model: "gemini-4-neon",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 5, output_tokens: 0 },
              },
            })}\n\n`,
            `data: ${JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "partial" },
            })}\n\n`,
            `data: ${JSON.stringify({
              type: "error",
              error: { type: "api_error", message: "mid-stream boom" },
            })}\n\n`,
          ].join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      ),
    )

    const translatedFailed = await app.request(
      "/v1beta/models/gemini-4-neon:streamGenerateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    )
    expect(translatedFailed.status).toBe(502)
    expect(await translatedFailed.json()).toMatchObject({
      error: { code: 502, message: "mid-stream boom", status: "INTERNAL" },
    })
    expect(endedEvents.at(-1)).toMatchObject({ status: 502, outcome: "error" })

    // 2. Native Google provider non-SSE stream emits a chunk then an error chunk
    const googleProvider: ResolvedProviderConfig = {
      name: "mygoogle",
      type: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "upstream-key",
      authType: "x-goog-api-key",
    }
    googleHandlerDependencies.resolveConfiguredProviderModelAlias = mock(() =>
      Promise.resolve({ provider: "mygoogle", model: "gemini-4-argon" }),
    )
    googleHandlerDependencies.resolveProviderConfig = mock(() =>
      Promise.resolve(googleProvider),
    )
    googleHandlerDependencies.forwardGoogleGenerateContent = mock(() =>
      Promise.resolve(
        new Response(
          [
            `data: ${JSON.stringify({
              candidates: [
                {
                  index: 0,
                  content: { role: "model", parts: [{ text: "ok" }] },
                },
              ],
            })}\n\n`,
            `data: ${JSON.stringify({
              error: {
                code: 13,
                message: "upstream internal",
                status: "INTERNAL",
              },
            })}\n\n`,
          ].join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      ),
    )

    const nativeFailed = await app.request(
      "/v1beta/models/mygoogle/gemini-4-argon:streamGenerateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    )
    expect(nativeFailed.status).toBe(502)
    expect(await nativeFailed.json()).toMatchObject({
      error: { code: 13, message: "upstream internal", status: "INTERNAL" },
    })
    expect(endedEvents.at(-1)).toMatchObject({ status: 502, outcome: "error" })
  })

  test("cancels stalled streams promptly on client abort without emitting synthetic 502 errors", async () => {
    const app = createServer()

    // 1. Translated SSE stream stalls after first text chunk, client aborts
    let innerSseCancelled = false
    let resolveSseCancelled!: () => void
    const sseCancelled = new Promise<void>((resolve) => {
      resolveSseCancelled = resolve
    })
    googleHandlerDependencies.handleCompletionPayload = mock(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const enc = new TextEncoder()
              controller.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "first" },
                  })}\n\n`,
                ),
              )
            },
            cancel() {
              innerSseCancelled = true
              resolveSseCancelled()
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      ),
    )

    const sseAbort = new AbortController()
    const sseRes = await app.request(
      "/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
        signal: sseAbort.signal,
      },
    )
    const reader = (sseRes.body as ReadableStream<Uint8Array>).getReader()
    const firstChunk = await reader.read()
    expect(new TextDecoder().decode(firstChunk.value)).toContain("first")
    sseAbort.abort()
    await reader.cancel()
    await sseCancelled
    expect(innerSseCancelled).toBe(true)

    // 2. Buffered JSON array mode stalls, client aborts -> returns 499 and cancels inner stream
    let innerArrayCancelled = false
    let arrayChunkSent = false
    const arrayAbort = new AbortController()
    googleHandlerDependencies.handleCompletionPayload = mock(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!arrayChunkSent) {
                arrayChunkSent = true
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({
                      type: "content_block_start",
                      index: 0,
                      content_block: { type: "text", text: "partial" },
                    })}\n\n`,
                  ),
                )
                return
              }
              queueMicrotask(() => arrayAbort.abort())
            },
            cancel() {
              innerArrayCancelled = true
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      ),
    )

    const abortedArrayRes = await app.request(
      "/v1beta/models/gemini-4-neon:streamGenerateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
        signal: arrayAbort.signal,
      },
    )
    expect(abortedArrayRes.status).toBe(499)
    expect(innerArrayCancelled).toBe(true)

    // 3. Native Google non-SSE passthrough stalls, client aborts -> returns 499 and cancels upstream
    let nativeCancelled = false
    let nativeChunkSent = false
    const nativeAbort = new AbortController()
    const googleProvider: ResolvedProviderConfig = {
      name: "mygoogle",
      type: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "upstream-key",
      authType: "x-goog-api-key",
    }
    googleHandlerDependencies.resolveConfiguredProviderModelAlias = mock(() =>
      Promise.resolve({ provider: "mygoogle", model: "gemini-4-argon" }),
    )
    googleHandlerDependencies.resolveProviderConfig = mock(() =>
      Promise.resolve(googleProvider),
    )
    googleHandlerDependencies.forwardGoogleGenerateContent = mock(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!nativeChunkSent) {
                nativeChunkSent = true
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({
                      candidates: [
                        {
                          index: 0,
                          content: { role: "model", parts: [{ text: "wait" }] },
                        },
                      ],
                    })}\n\n`,
                  ),
                )
                return
              }
              queueMicrotask(() => nativeAbort.abort())
            },
            cancel() {
              nativeCancelled = true
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      ),
    )

    const abortedNativeRes = await app.request(
      "/v1beta/models/mygoogle/gemini-4-argon:streamGenerateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
        signal: nativeAbort.signal,
      },
    )
    expect(abortedNativeRes.status).toBe(499)
    expect(nativeCancelled).toBe(true)
  })

  test("applies missing modelConfig defaults and extraBody on native Google provider passthrough", async () => {
    const app = createServer()
    const googleProvider: ResolvedProviderConfig = {
      name: "mygoogle",
      type: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "upstream-key",
      authType: "x-goog-api-key",
      models: {
        "gemini-4-argon": {
          temperature: 0.4,
          topP: 0.9,
          topK: 32,
          extraBody: {
            cachedContent: "cachedContents/default",
            generationConfig: {
              maxOutputTokens: 8192,
              temperature: 0.9,
            },
          },
        },
      },
    }
    googleHandlerDependencies.resolveConfiguredProviderModelAlias = mock(() =>
      Promise.resolve({ provider: "mygoogle", model: "gemini-4-argon" }),
    )
    googleHandlerDependencies.resolveProviderConfig = mock(() =>
      Promise.resolve(googleProvider),
    )

    let capturedPayload: unknown
    googleHandlerDependencies.forwardGoogleGenerateContent = mock(
      (_provider, _model, payload) => {
        capturedPayload = payload
        return Promise.resolve(
          Response.json({
            candidates: [
              {
                index: 0,
                content: { role: "model", parts: [{ text: "ok" }] },
                finishReason: "STOP",
              },
            ],
          }),
        )
      },
    )

    const res = await app.request(
      "/v1beta/models/mygoogle/gemini-4-argon:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
          generationConfig: { topP: 0.7 },
        }),
      },
    )

    expect(res.status).toBe(200)
    expect(capturedPayload).toEqual({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      cachedContent: "cachedContents/default",
      generationConfig: {
        topP: 0.7,
        temperature: 0.4,
        topK: 32,
        maxOutputTokens: 8192,
      },
    })
  })

  test("forwards Gemini inlineData, thoughtSignature, and structured schemas to Chat Completions and Responses APIs", async () => {
    const app = createServer()
    const sig = Buffer.from("opaque-sig").toString("base64")

    createChatCompletions.mockImplementationOnce(() =>
      Promise.resolve({
        id: "chatcmpl-so",
        object: "chat.completion" as const,
        created: 0,
        model: "gemini-4-neon",
        choices: [
          {
            index: 0,
            message: { role: "assistant" as const, content: '{"ok":true}' },
            logprobs: null,
            finish_reason: "stop" as const,
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      }),
    )

    const chatRes = await app.request(
      "/v1beta/models/gemini-4-neon:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: "Analyze image" },
                { inlineData: { mimeType: "image/png", data: "aW1n" } },
              ],
            },
            {
              role: "model",
              parts: [
                {
                  functionCall: {
                    id: "call_1",
                    name: "inspect",
                    args: { target_path: "a.png" },
                  },
                  thoughtSignature: sig,
                },
              ],
            },
            {
              role: "user",
              parts: [
                {
                  functionResponse: {
                    id: "call_1",
                    name: "inspect",
                    response: { status: "ok" },
                  },
                },
              ],
            },
          ],
          generationConfig: {
            responseFormat: {
              text: {
                mimeType: "APPLICATION_JSON",
                schema: {
                  title: "Image Verdict",
                  type: "OBJECT",
                  properties: { ok: { type: "BOOLEAN" } },
                  required: ["ok"],
                },
              },
            },
          },
        }),
      },
    )

    expect(chatRes.status).toBe(200)
    const chatReq = createChatCompletions.mock.calls[0]?.[0]
    expect(chatReq?.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "Image_Verdict",
        schema: {
          title: "Image Verdict",
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
    })
    expect(chatReq?.messages[0]?.content).toEqual([
      { type: "text", text: "Analyze image" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
    ])
    expect(chatReq?.messages[1]?.reasoning_opaque).toBe(sig)

    // Configure Copilot Responses model with structured_outputs support + another without support
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-5.4",
          name: "gpt-5.4",
          object: "model",
          preview: false,
          vendor: "openai",
          version: "1",
          model_picker_enabled: true,
          supported_endpoints: ["/responses"],
          capabilities: {
            family: "gpt",
            limits: { max_output_tokens: 16384 },
            object: "model_capabilities",
            supports: { structured_outputs: true },
            tokenizer: "o200k_base",
            type: "chat",
          },
        },
        {
          id: "legacy-no-schema",
          name: "legacy-no-schema",
          object: "model",
          preview: false,
          vendor: "openai",
          version: "1",
          model_picker_enabled: true,
          supported_endpoints: ["/chat/completions"],
          capabilities: {
            family: "gpt",
            limits: { max_output_tokens: 4096 },
            object: "model_capabilities",
            supports: { structured_outputs: false },
            tokenizer: "o200k_base",
            type: "chat",
          },
        },
      ],
    }

    createResponses.mockImplementationOnce(() =>
      Promise.resolve({
        ...createResponsesResult("gpt-5.4"),
        id: "resp_so",
        output: [
          {
            id: "msg_out",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: '{"ok":true}' }],
          },
        ],
        output_text: '{"ok":true}',
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      }),
    )

    const respRes = await app.request(
      "/v1beta/models/gpt-5.4:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Return JSON" }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: {
              title: "Check",
              type: "object",
              properties: { ok: { type: "boolean" } },
            },
          },
        }),
      },
    )
    expect(respRes.status).toBe(200)
    const respReq = createResponses.mock.calls[0]?.[0]
    expect(respReq?.text).toEqual({
      format: {
        type: "json_schema",
        name: "Check",
        schema: {
          title: "Check",
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
        strict: false,
      },
    })

    // Model declaring structured_outputs: false returns an explicit 400 error
    const unsupportedRes = await app.request(
      "/v1beta/models/legacy-no-schema:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Return JSON" }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: { type: "object" },
          },
        }),
      },
    )
    expect(unsupportedRes.status).toBe(400)
  })

  test("round-trips multiple Responses reasoning items in order for both JSON and SSE", async () => {
    const app = createServer()
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-5.4",
          name: "gpt-5.4",
          object: "model",
          preview: false,
          vendor: "openai",
          version: "1",
          model_picker_enabled: true,
          supported_endpoints: ["/responses"],
          capabilities: {
            family: "gpt",
            limits: { max_output_tokens: 16384 },
            object: "model_capabilities",
            supports: { structured_outputs: true },
            tokenizer: "o200k_base",
            type: "chat",
          },
        },
      ],
    }

    // 1) Non-streaming JSON round-trip with 2 reasoning items
    createResponses.mockImplementationOnce(() =>
      Promise.resolve({
        ...createResponsesResult("gpt-5.4"),
        id: "resp_multi_json_1",
        output: [
          {
            id: "rs_1",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "First thought" }],
            encrypted_content: "enc_1",
          },
          {
            id: "rs_2",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Second thought" }],
            encrypted_content: "enc_2",
          },
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Answer 1" }],
          },
        ],
        output_text: "Answer 1",
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      }),
    )

    const jsonTurn1Res = await app.request(
      "/v1beta/models/gpt-5.4:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Start" }] }],
        }),
      },
    )
    expect(jsonTurn1Res.status).toBe(200)
    const jsonTurn1 =
      (await jsonTurn1Res.json()) as GoogleGenerateContentResponse
    const jsonTurn1Parts = jsonTurn1.candidates?.[0]?.content?.parts ?? []

    createResponses.mockImplementationOnce(() =>
      Promise.resolve({
        ...createResponsesResult("gpt-5.4"),
        id: "resp_multi_json_2",
        output: [
          {
            id: "msg_2",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Answer 2" }],
          },
        ],
        output_text: "Answer 2",
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      }),
    )

    const jsonTurn2Res = await app.request(
      "/v1beta/models/gpt-5.4:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: "Start" }] },
            { role: "model", parts: jsonTurn1Parts },
            { role: "user", parts: [{ text: "Continue" }] },
          ],
        }),
      },
    )
    expect(jsonTurn2Res.status).toBe(200)
    const jsonTurn2Input = createResponses.mock.calls[1]?.[0]?.input
    const jsonReasonings = (
      Array.isArray(jsonTurn2Input) ? jsonTurn2Input : []).filter(
      (item) => item.type === "reasoning",
    )
    expect(jsonReasonings).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "First thought" }],
        encrypted_content: "enc_1",
      },
      {
        type: "reasoning",
        id: "rs_2",
        summary: [{ type: "summary_text", text: "Second thought" }],
        encrypted_content: "enc_2",
      },
    ])

    // 2) Streaming SSE round-trip with 2 reasoning items
    createResponses.mockImplementationOnce(() =>
      Promise.resolve(
        streamEvents([
          {
            data: JSON.stringify({
              type: "response.created",
              sequence_number: 0,
              response: {
                id: "resp_multi_sse_1",
                object: "response",
                model: "gpt-5.4",
                status: "in_progress",
                output: [],
                output_text: "",
                error: null,
                incomplete_details: null,
                instructions: null,
              },
            }),
          },
          {
            data: JSON.stringify({
              type: "response.reasoning_summary_text.delta",
              sequence_number: 1,
              item_id: "rs_a",
              output_index: 0,
              summary_index: 0,
              delta: "Stream step 1",
            }),
          },
          {
            data: JSON.stringify({
              type: "response.output_item.done",
              sequence_number: 2,
              output_index: 0,
              item: {
                id: "rs_a",
                type: "reasoning",
                summary: [{ type: "summary_text", text: "Stream step 1" }],
                encrypted_content: "enc_a",
              },
            }),
          },
          {
            data: JSON.stringify({
              type: "response.reasoning_summary_text.delta",
              sequence_number: 3,
              item_id: "rs_b",
              output_index: 1,
              summary_index: 0,
              delta: "Stream step 2",
            }),
          },
          {
            data: JSON.stringify({
              type: "response.output_item.done",
              sequence_number: 4,
              output_index: 1,
              item: {
                id: "rs_b",
                type: "reasoning",
                summary: [{ type: "summary_text", text: "Stream step 2" }],
                encrypted_content: "enc_b",
              },
            }),
          },
          {
            data: JSON.stringify({
              type: "response.output_text.delta",
              sequence_number: 5,
              item_id: "msg_s",
              output_index: 2,
              content_index: 0,
              delta: "Streamed answer",
            }),
          },
          {
            data: JSON.stringify({
              type: "response.completed",
              sequence_number: 6,
              response: {
                id: "resp_multi_sse_1",
                object: "response",
                model: "gpt-5.4",
                status: "completed",
                output: [],
                output_text: "Streamed answer",
                usage: {
                  input_tokens: 10,
                  output_tokens: 10,
                  total_tokens: 20,
                },
                error: null,
                incomplete_details: null,
                instructions: null,
              },
            }),
          },
        ]),
      ),
    )

    const sseTurn1Res = await app.request(
      "/v1beta/models/gpt-5.4:streamGenerateContent?alt=sse",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Start stream" }] }],
        }),
      },
    )
    expect(sseTurn1Res.status).toBe(200)
    const sseTurn1Chunks = parseSseDataEvents(await sseTurn1Res.text())
    const sseTurn1Parts = sseTurn1Chunks.flatMap(
      (chunk) => chunk.candidates?.[0]?.content?.parts ?? [],
    )

    createResponses.mockImplementationOnce(() =>
      Promise.resolve({
        ...createResponsesResult("gpt-5.4"),
        id: "resp_multi_sse_2",
        output: [
          {
            id: "msg_s2",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done" }],
          },
        ],
        output_text: "Done",
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      }),
    )

    const sseTurn2Res = await app.request(
      "/v1beta/models/gpt-5.4:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: "Start stream" }] },
            { role: "model", parts: sseTurn1Parts },
            { role: "user", parts: [{ text: "Follow up" }] },
          ],
        }),
      },
    )
    expect(sseTurn2Res.status).toBe(200)
    const sseTurn2Input = createResponses.mock.calls[3]?.[0]?.input
    const sseReasonings = (
      Array.isArray(sseTurn2Input) ? sseTurn2Input : []).filter(
      (item) => item.type === "reasoning",
    )
    expect(sseReasonings).toEqual([
      {
        type: "reasoning",
        id: "rs_a",
        summary: [{ type: "summary_text", text: "Stream step 1" }],
        encrypted_content: "enc_a",
      },
      {
        type: "reasoning",
        id: "rs_b",
        summary: [{ type: "summary_text", text: "Stream step 2" }],
        encrypted_content: "enc_b",
      },
    ])
  })

  test.each([
    { end: "answer", layout: "interleaved" },
    { end: "tool", layout: "interleaved" },
    { end: "answer", layout: "consecutive" },
    { end: "tool", layout: "consecutive" },
  ] as const)(
    "recovers $end history with $layout Responses reasoning after Antigravity merges it",
    async ({ end, layout }) => {
      const model = "gpt-5.4"
      state.models = {
        object: "list",
        data: [
          {
            id: model,
            name: model,
            object: "model",
            preview: false,
            vendor: "openai",
            version: "1",
            model_picker_enabled: true,
            supported_endpoints: ["/responses"],
            capabilities: {
              family: "gpt",
              limits: { max_output_tokens: 16384 },
              object: "model_capabilities",
              supports: {},
              tokenizer: "o200k_base",
              type: "chat",
            },
          },
        ],
      }
      const first: ResponseOutputReasoning = {
        id: "rs_first",
        type: "reasoning",
        encrypted_content: "cipher-first",
        summary: [{ type: "summary_text", text: "First step 🚀." }],
      }
      const second: ResponseOutputReasoning = {
        id: "rs_second",
        type: "reasoning",
        encrypted_content: "cipher-second",
        summary: [{ type: "summary_text", text: "Second step." }],
      }
      const tool: ResponseOutputFunctionCall = {
        type: "function_call",
        id: "fc_read",
        call_id: "call_read",
        name: "read_file",
        arguments: '{"path":"README.md"}',
        status: "completed",
      }
      const result = createResponsesResult(model)
      const interleaved = layout === "interleaved"
      const secondIndex = interleaved ? 2 : 1
      const progress = "Checking 🚀. "
      const answer = "Done."
      const upstream: Array<ResponseStreamEvent> = [
        {
          type: "response.created",
          sequence_number: 0,
          response: { ...result, status: "in_progress" },
        },
        {
          type: "response.reasoning_summary_text.delta",
          sequence_number: 1,
          output_index: 0,
          item_id: first.id,
          summary_index: 0,
          delta: first.summary?.[0]?.text ?? "",
        },
        {
          type: "response.output_item.done",
          sequence_number: 2,
          output_index: 0,
          item: first,
        },
      ]
      if (interleaved) {
        upstream.push({
          type: "response.output_text.delta",
          sequence_number: 3,
          output_index: 1,
          content_index: 0,
          item_id: "msg_progress",
          delta: progress,
        })
      }
      upstream.push(
        {
          type: "response.reasoning_summary_text.delta",
          sequence_number: 4,
          output_index: secondIndex,
          item_id: second.id,
          summary_index: 0,
          delta: second.summary?.[0]?.text ?? "",
        },
        {
          type: "response.output_item.done",
          sequence_number: 5,
          output_index: secondIndex,
          item: second,
        },
      )
      if (end === "tool") {
        upstream.push(
          {
            type: "response.output_item.added",
            sequence_number: 6,
            output_index: secondIndex + 1,
            item: { ...tool, status: "in_progress" },
          },
          {
            type: "response.output_item.done",
            sequence_number: 7,
            output_index: secondIndex + 1,
            item: tool,
          },
        )
      } else {
        upstream.push({
          type: "response.output_text.delta",
          sequence_number: 6,
          output_index: secondIndex + 1,
          content_index: 0,
          item_id: "msg_answer",
          delta: answer,
        })
      }
      upstream.push({
        type: "response.completed",
        sequence_number: 8,
        response: {
          ...result,
          output: end === "tool" ? [first, second, tool] : [first, second],
        },
      })
      createResponses.mockImplementationOnce(() =>
        Promise.resolve(
          streamEvents(
            upstream.map((event) => ({ data: JSON.stringify(event) })),
          ),
        ),
      )
      createResponses.mockResolvedValueOnce(result)

      const app = createServer()
      const headers = {
        "content-type": "application/json",
        "user-agent":
          "antigravity/cli/1.5.16 (aidev_client; auth_method=gateway)",
      }
      const initial = { role: "user", parts: [{ text: "Start" }] }
      const streamed = await app.request(
        "/v1beta/models/gpt-5.4:streamGenerateContent?alt=sse",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ contents: [initial] }),
        },
      )
      expect(streamed.status).toBe(200)
      const parts = parseSseDataEvents(await streamed.text()).flatMap(
        (chunk) => chunk.candidates?.[0]?.content?.parts ?? [],
      )
      const toolPart = parts.find((part) => part.functionCall)
      const signatures = parts.filter(
        (part) => part.thoughtSignature && !part.functionCall,
      )
      expect(signatures).toHaveLength(end === "tool" ? 0 : 1)
      const text = parts
        .filter((part) => !part.thought)
        .map((part) => part.text)
        .join("")
      const merged: Array<GooglePart> = []
      // The CLI can replay a tool call without the preceding thought part.
      if (end === "answer") {
        merged.push({
          thought: true,
          text: parts
            .filter((part) => part.thought)
            .map((part) => part.text)
            .join(""),
        })
      }
      if (text) {
        merged.push({ text, thoughtSignature: signatures[0]?.thoughtSignature })
      }
      if (toolPart?.functionCall) {
        const { id: _strippedId, ...functionCall } = toolPart.functionCall
        merged.push({ ...toolPart, functionCall })
      }
      const followUp =
        end === "tool" ?
          { functionResponse: { name: tool.name, response: { output: "OK" } } }
        : { text: "Continue" }
      const next = await app.request("/v1beta/models/gpt-5.4:generateContent", {
        method: "POST",
        headers,
        body: JSON.stringify({
          contents: [
            initial,
            { role: "model", parts: merged },
            { role: "user", parts: [followUp] },
          ],
        }),
      })
      expect(next.status).toBe(200)
      const input = createResponses.mock.calls[1]?.[0]?.input
      expect(Array.isArray(input)).toBe(true)
      const terminalItems: Array<Partial<ResponseInputItem>> =
        end === "tool" ?
          [
            { type: "function_call", name: tool.name, call_id: tool.call_id },
            {
              type: "function_call_output",
              call_id: tool.call_id,
              output: "OK",
            },
          ]
        : [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: answer }],
            },
          ]
      const expected: Array<
        Partial<ResponseInputItem> | ResponseOutputReasoning
      > = [first]
      if (interleaved) {
        expected.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: progress }],
        })
      }
      expected.push(second, ...terminalItems)
      expect(
        (input as Array<ResponseInputItem>).slice(1, 1 + expected.length),
      ).toMatchObject(expected)
    },
  )

  test("returns MAX_TOKENS instead of 502 when streaming tool call hits max output tokens", async () => {
    const app = createServer()

    createChatCompletions.mockImplementationOnce(() =>
      Promise.resolve(
        streamEvents([
          makeOpenAIChunk({
            tool_calls: [
              {
                index: 0,
                id: "call_trunc",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: '{"path":"big.ts","content":"cut off',
                },
              },
            ],
          }),
          makeOpenAIChunk(
            {},
            {
              finishReason: "length",
              usage: {
                prompt_tokens: 50,
                completion_tokens: 4096,
                total_tokens: 4146,
              },
            },
          ),
          { data: "[DONE]" },
        ]),
      ),
    )

    const res = await app.request(
      "/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Write big.ts" }] }],
        }),
      },
    )

    expect(res.status).toBe(200)
    const chunks = parseSseDataEvents(await res.text())
    expect(chunks.some((chunk) => chunk.error)).toBe(false)
    expect(chunks.at(-1)?.candidates?.[0]?.finishReason).toBe("MAX_TOKENS")
  })

  test.each(["generateContent", "streamGenerateContent"] as const)(
    "preserves Antigravity interleaved Responses reasoning over non-SSE %s",
    async (action) => {
      const model = "gpt-5.4"
      state.models = {
        object: "list",
        data: [
          {
            id: model,
            name: model,
            object: "model",
            preview: false,
            vendor: "openai",
            version: "1",
            model_picker_enabled: true,
            supported_endpoints: ["/responses"],
            capabilities: {
              family: "gpt",
              limits: { max_output_tokens: 16384 },
              object: "model_capabilities",
              supports: {},
              tokenizer: "o200k_base",
              type: "chat",
            },
          },
        ],
      }
      const first: ResponseOutputReasoning = {
        id: "rs_non_sse_1",
        type: "reasoning",
        encrypted_content: "cipher-1",
        summary: [{ type: "summary_text", text: "Step one." }],
      }
      const second: ResponseOutputReasoning = {
        id: "rs_non_sse_2",
        type: "reasoning",
        encrypted_content: "cipher-2",
        summary: [],
      }
      const progress = "Working. "
      const answer = "Finished."
      const result = createResponsesResult(model)

      if (action === "generateContent") {
        createResponses.mockResolvedValueOnce({
          ...result,
          output: [
            first,
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: progress }],
            },
            second,
            {
              id: "msg_2",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: answer }],
            },
          ],
          output_text: `${progress}${answer}`,
        })
      } else {
        const upstream: Array<ResponseStreamEvent> = [
          {
            type: "response.created",
            sequence_number: 0,
            response: { ...result, status: "in_progress" },
          },
          {
            type: "response.reasoning_summary_text.delta",
            sequence_number: 1,
            output_index: 0,
            item_id: first.id,
            summary_index: 0,
            delta: "Step one.",
          },
          {
            type: "response.output_item.done",
            sequence_number: 2,
            output_index: 0,
            item: first,
          },
          {
            type: "response.output_text.delta",
            sequence_number: 3,
            output_index: 1,
            content_index: 0,
            item_id: "msg_1",
            delta: progress,
          },
          {
            type: "response.output_item.done",
            sequence_number: 4,
            output_index: 2,
            item: second,
          },
          {
            type: "response.output_text.delta",
            sequence_number: 5,
            output_index: 3,
            content_index: 0,
            item_id: "msg_2",
            delta: answer,
          },
          {
            type: "response.completed",
            sequence_number: 6,
            response: { ...result, output: [first, second] },
          },
        ]
        createResponses.mockImplementationOnce(() =>
          Promise.resolve(
            streamEvents(
              upstream.map((event) => ({ data: JSON.stringify(event) })),
            ),
          ),
        )
      }
      createResponses.mockResolvedValueOnce(result)

      const app = createServer()
      const headers = {
        "content-type": "application/json",
        "user-agent":
          "antigravity/cli/1.5.16 (aidev_client; auth_method=gateway)",
      }
      const initial = { role: "user", parts: [{ text: "Start" }] }
      const turn1 = await app.request(`/v1beta/models/${model}:${action}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ contents: [initial] }),
      })
      expect(turn1.status).toBe(200)
      const turn1Body = (await turn1.json()) as
        | GoogleGenerateContentResponse
        | Array<GoogleGenerateContentResponse>
      const responseItems = Array.isArray(turn1Body) ? turn1Body : [turn1Body]
      const parts = responseItems.flatMap(
        (chunk) => chunk.candidates?.[0]?.content?.parts ?? [],
      )
      const sigBytes = parts.flatMap((part) =>
        part.thoughtSignature ?
          [Buffer.from(part.thoughtSignature, "base64")]
        : [],
      )
      expect(sigBytes).toHaveLength(1)

      const merged: Array<GooglePart> = [
        {
          thought: true,
          text: parts
            .filter((part) => part.thought)
            .map((part) => part.text)
            .join(""),
        },
        {
          text: parts
            .filter((part) => !part.thought)
            .map((part) => part.text)
            .join(""),
          thoughtSignature: Buffer.concat(sigBytes).toString("base64"),
        },
      ]

      const turn2 = await app.request(
        `/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            contents: [
              initial,
              { role: "model", parts: merged },
              { role: "user", parts: [{ text: "Continue" }] },
            ],
          }),
        },
      )
      expect(turn2.status).toBe(200)
      const input = createResponses.mock.calls[1]?.[0]?.input
      expect(Array.isArray(input)).toBe(true)
      expect((input as Array<ResponseInputItem>).slice(1, 5)).toMatchObject([
        first,
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: progress }],
        },
        second,
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: answer }],
        },
      ])
    },
  )

  test("preserves original parallel Responses tool call IDs when Antigravity CLI strips id on replay", async () => {
    const model = "gpt-5.4"
    state.models = {
      object: "list",
      data: [
        {
          id: model,
          name: model,
          object: "model",
          preview: false,
          vendor: "openai",
          version: "1",
          model_picker_enabled: true,
          supported_endpoints: ["/responses"],
          capabilities: {
            family: "gpt",
            limits: { max_output_tokens: 16384 },
            object: "model_capabilities",
            supports: {},
            tokenizer: "o200k_base",
            type: "chat",
          },
        },
      ],
    }

    const reasoning: ResponseOutputReasoning = {
      id: "rs_parallel_1",
      type: "reasoning",
      encrypted_content: "cipher-parallel-1",
      summary: [{ type: "summary_text", text: "Reading two files." }],
    }
    const tool1: ResponseOutputFunctionCall = {
      id: "fc_parallel_1",
      type: "function_call",
      call_id: "call_f04518a904314f7ca40b1d265bec1575",
      name: "read_file",
      arguments: '{"path":"a.ts"}',
      status: "completed",
    }
    const tool2: ResponseOutputFunctionCall = {
      id: "fc_parallel_2",
      type: "function_call",
      call_id: "call_98b2c4d6e8f0123456789abcdef01234",
      name: "read_file",
      arguments: '{"path":"b.ts"}',
      status: "completed",
    }
    const result = createResponsesResult(model)
    const upstream: Array<ResponseStreamEvent> = [
      {
        type: "response.created",
        sequence_number: 0,
        response: { ...result, status: "in_progress" },
      },
      {
        type: "response.reasoning_summary_text.delta",
        sequence_number: 1,
        output_index: 0,
        item_id: reasoning.id,
        summary_index: 0,
        delta: "Reading two files.",
      },
      {
        type: "response.output_item.done",
        sequence_number: 2,
        output_index: 0,
        item: reasoning,
      },
      {
        type: "response.output_item.added",
        sequence_number: 3,
        output_index: 1,
        item: { ...tool1, status: "in_progress" },
      },
      {
        type: "response.output_item.done",
        sequence_number: 4,
        output_index: 1,
        item: tool1,
      },
      {
        type: "response.output_item.added",
        sequence_number: 5,
        output_index: 2,
        item: { ...tool2, status: "in_progress" },
      },
      {
        type: "response.output_item.done",
        sequence_number: 6,
        output_index: 2,
        item: tool2,
      },
      {
        type: "response.completed",
        sequence_number: 7,
        response: { ...result, output: [reasoning, tool1, tool2] },
      },
    ]

    createResponses.mockImplementationOnce(() =>
      Promise.resolve(
        streamEvents(
          upstream.map((event) => ({ data: JSON.stringify(event) })),
        ),
      ),
    )
    createResponses.mockResolvedValueOnce(result)

    const app = createServer()
    const headers = {
      "content-type": "application/json",
      "user-agent":
        "antigravity/cli/1.5.17 (aidev_client; auth_method=gateway)",
    }
    const initial = { role: "user", parts: [{ text: "Read both files" }] }
    const turn1 = await app.request(
      `/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ contents: [initial] }),
      },
    )
    expect(turn1.status).toBe(200)
    const parts = parseSseDataEvents(await turn1.text()).flatMap(
      (chunk) => chunk.candidates?.[0]?.content?.parts ?? [],
    )
    const toolParts = parts.filter((part) => part.functionCall)
    expect(toolParts).toHaveLength(2)
    expect(toolParts.every((part) => Boolean(part.thoughtSignature))).toBe(true)

    // Replay exactly like Antigravity CLI: strip functionCall.id and functionResponse.id
    const replayedModelParts: Array<GooglePart> = toolParts.map((part) => ({
      functionCall: {
        name: part.functionCall!.name,
        args: part.functionCall!.args,
      },
      thoughtSignature: part.thoughtSignature,
    }))
    const turn2 = await app.request(`/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: [
          initial,
          { role: "model", parts: replayedModelParts },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "read_file",
                  response: { output: "file A" },
                },
              },
              {
                functionResponse: {
                  name: "read_file",
                  response: { output: "file B" },
                },
              },
            ],
          },
        ],
      }),
    })
    expect(turn2.status).toBe(200)

    const input = createResponses.mock.calls[1]?.[0]?.input
    expect(Array.isArray(input)).toBe(true)
    expect((input as Array<ResponseInputItem>).slice(1, 6)).toMatchObject([
      reasoning,
      { type: "function_call", name: "read_file", call_id: tool1.call_id },
      { type: "function_call", name: "read_file", call_id: tool2.call_id },
      {
        type: "function_call_output",
        call_id: tool1.call_id,
        output: "file A",
      },
      {
        type: "function_call_output",
        call_id: tool2.call_id,
        output: "file B",
      },
    ])
  })

  test("strips gateway Antigravity thoughtSignature envelopes before native Google passthrough", async () => {
    const provider: ResolvedProviderConfig = {
      name: "mygoogle",
      type: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "google-test-key",
      authType: "x-goog-api-key",
    }
    googleHandlerDependencies.resolveConfiguredProviderModelAlias = mock(() =>
      Promise.resolve({ provider: provider.name, model: "gemini-2.5-pro" }),
    )
    googleHandlerDependencies.resolveProviderConfig = mock(() =>
      Promise.resolve(provider),
    )
    const forward = mock<typeof originalForwardGoogle>(() =>
      Promise.resolve(
        Response.json({
          candidates: [
            {
              index: 0,
              content: { role: "model", parts: [{ text: "ok" }] },
              finishReason: "STOP",
            },
          ],
        }),
      ),
    )
    googleHandlerDependencies.forwardGoogleGenerateContent = forward

    const nativeSig = Buffer.from("native-google-signature").toString("base64")
    const agyTextSig = encodeAntigravitySignatures([["enc_1@rs_1", 4, 0]])
    const agyCallSig = encodeAntigravityToolCallSignature("call_1234")

    const app = createServer()
    const res = await app.request(
      "/v1beta/models/mygoogle/gemini-2.5-pro:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent":
            "antigravity/cli/1.5.17 (aidev_client; auth_method=gateway)",
        },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: "Start" }] },
            {
              role: "model",
              parts: [
                { text: "Done", thoughtSignature: agyTextSig },
                { text: "", thoughtSignature: agyTextSig },
                {
                  functionCall: { name: "read_file", args: { path: "a.ts" } },
                  thoughtSignature: agyCallSig,
                },
                { text: "Native", thoughtSignature: nativeSig },
              ],
            },
            {
              role: "user",
              parts: [
                {
                  functionResponse: {
                    name: "read_file",
                    response: { output: "content" },
                  },
                },
              ],
            },
          ],
        }),
      },
    )

    expect(res.status).toBe(200)
    expect(forward).toHaveBeenCalledTimes(1)
    expect(forward.mock.calls[0]?.[2].contents?.[1]).toEqual({
      role: "model",
      parts: [
        { text: "Done" },
        { functionCall: { name: "read_file", args: { path: "a.ts" } } },
        { text: "Native", thoughtSignature: nativeSig },
      ],
    })
  })

  test("routes googleSearch-only generateContent through Copilot Responses web search and returns groundingMetadata", async () => {
    googleHandlerDependencies.getMessageApiWebSearchModel = () => "gpt-6-luna"
    googleHandlerDependencies.isResponsesApiWebSearchEnabled = () => true
    webSearchFlowDependencies.getMessageApiWebSearchModel = () => "gpt-6-luna"
    const wsResponses = mock<typeof originalWebSearchCreateResponses>(() =>
      Promise.resolve({
        ...createResponsesResult("gpt-6-luna"),
        id: "resp_google_search_1",
        output: [
          {
            type: "web_search_call",
            action: {
              query: "Python 3.14 release notes site:docs.python.org",
            },
          } as unknown as NonNullable<
            ReturnType<typeof createResponsesResult>["output"]
          >[number],
          {
            type: "message",
            id: "msg_ws_1",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Python 3.14 adds template string literals and deferred annotations.",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://docs.python.org/3.14/whatsnew/3.14.html",
                    title: "What's New In Python 3.14",
                  },
                ],
              },
            ],
          } as unknown as NonNullable<
            ReturnType<typeof createResponsesResult>["output"]
          >[number],
        ],
        usage: { input_tokens: 30, output_tokens: 20, total_tokens: 50 },
      }),
    )
    webSearchFlowDependencies.createResponses = wsResponses

    const app = createServer()
    const response = await app.request(
      "/v1beta/models/gemini-3.8-flash:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...antigravityHeaders,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: "Python 3.14 release notes site:docs.python.org" },
              ],
            },
          ],
          tools: [
            {
              googleSearch: {
                enhancedContent: { imageSearch: { maxResultCount: 5 } },
              },
            },
          ],
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(wsResponses).toHaveBeenCalledTimes(1)
    expect(wsResponses.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-6-luna",
      tools: [{ type: "web_search", search_context_size: "low" }],
    })

    const body = (await response.json()) as GoogleGenerateContentResponse
    expect(body.candidates?.[0]).toEqual({
      index: 0,
      content: {
        role: "model",
        parts: [
          {
            text: "Python 3.14 adds template string literals and deferred annotations.",
          },
        ],
      },
      finishReason: "STOP",
      groundingMetadata: {
        webSearchQueries: ["Python 3.14 release notes site:docs.python.org"],
        groundingChunks: [
          {
            web: {
              uri: "https://docs.python.org/3.14/whatsnew/3.14.html",
              title: "What's New In Python 3.14",
            },
          },
        ],
      },
    })
  })

  test("streams googleSearch-only streamGenerateContent?alt=sse with groundingMetadata on the final chunk", async () => {
    googleHandlerDependencies.getMessageApiWebSearchModel = () => "gpt-6-luna"
    googleHandlerDependencies.isResponsesApiWebSearchEnabled = () => true
    webSearchFlowDependencies.getMessageApiWebSearchModel = () => "gpt-6-luna"
    webSearchFlowDependencies.createResponses = mock<
      typeof originalWebSearchCreateResponses
    >(() =>
      Promise.resolve({
        ...createResponsesResult("gpt-6-luna"),
        id: "resp_google_search_sse",
        output: [
          {
            type: "web_search_call",
            action: { query: "bun latest release" },
          } as unknown as NonNullable<
            ReturnType<typeof createResponsesResult>["output"]
          >[number],
          {
            type: "message",
            id: "msg_ws_sse",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Bun 1.4 is available.",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://bun.sh/blog",
                    title: "Bun Blog",
                  },
                ],
              },
            ],
          } as unknown as NonNullable<
            ReturnType<typeof createResponsesResult>["output"]
          >[number],
        ],
        usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
      }),
    )

    const app = createServer()
    const response = await app.request(
      "/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "bun latest release" }] }],
          tools: [{ googleSearch: {} }],
        }),
      },
    )

    expect(response.status).toBe(200)
    const chunks = parseSseDataEvents(await response.text())
    const combinedText = chunks
      .flatMap((chunk) => chunk.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
    expect(combinedText).toBe("Bun 1.4 is available.")
    const finalChunk = chunks.at(-1)
    expect(finalChunk?.candidates?.[0]?.finishReason).toBe("STOP")
    expect(finalChunk?.candidates?.[0]?.groundingMetadata).toEqual({
      webSearchQueries: ["bun latest release"],
      groundingChunks: [
        { web: { uri: "https://bun.sh/blog", title: "Bun Blog" } },
      ],
    })
  })

  test("returns 400 when googleSearch is requested without gateway web search configured or enabled", async () => {
    const completionSpy = mock(originalHandleCompletionPayload)
    googleHandlerDependencies.handleCompletionPayload = completionSpy
    const app = createServer()

    const sendSearchRequest = () =>
      app.request("/v1beta/models/gemini-3.8-flash:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
          tools: [{ googleSearch: {} }],
        }),
      })

    // 1. messageApiWebSearchModel unset
    googleHandlerDependencies.getMessageApiWebSearchModel = () => undefined
    googleHandlerDependencies.isResponsesApiWebSearchEnabled = () => true
    const unsetRes = await sendSearchRequest()
    expect(unsetRes.status).toBe(400)
    const unsetBody = (await unsetRes.json()) as GoogleGenerateContentResponse
    expect(unsetBody.error?.code).toBe(400)
    expect(unsetBody.error?.message).toContain("messageApiWebSearchModel")

    // 2. useResponsesApiWebSearch disabled for a Copilot model
    googleHandlerDependencies.getMessageApiWebSearchModel = () => "gpt-6-luna"
    googleHandlerDependencies.isResponsesApiWebSearchEnabled = () => false
    const disabledRes = await sendSearchRequest()
    expect(disabledRes.status).toBe(400)
    const disabledBody =
      (await disabledRes.json()) as GoogleGenerateContentResponse
    expect(disabledBody.error?.message).toContain("useResponsesApiWebSearch")

    // 3. provider/model alias does not match an enabled provider
    googleHandlerDependencies.getMessageApiWebSearchModel = () =>
      "missing-provider/search-model"
    googleHandlerDependencies.isResponsesApiWebSearchEnabled = () => true
    googleHandlerDependencies.resolveProviderConfig = () =>
      Promise.resolve(null)
    const missingRes = await sendSearchRequest()
    expect(missingRes.status).toBe(400)
    const missingBody =
      (await missingRes.json()) as GoogleGenerateContentResponse
    expect(missingBody.error?.message).toContain(
      "missing-provider/search-model",
    )

    // 4. provider/model alias uses openai-compatible (no server-side web search)
    googleHandlerDependencies.getMessageApiWebSearchModel = () =>
      "compat/search-model"
    googleHandlerDependencies.resolveProviderConfig = (provider) =>
      Promise.resolve(
        provider === "compat" ?
          ({
            name: "compat",
            type: "openai-compatible",
            baseUrl: "https://compat.example/v1",
            apiKey: "test-key",
            authType: "authorization",
            models: {},
          } satisfies ResolvedProviderConfig)
        : null,
      )
    const compatRes = await sendSearchRequest()
    expect(compatRes.status).toBe(400)
    const compatBody = (await compatRes.json()) as GoogleGenerateContentResponse
    expect(compatBody.error?.message).toContain("openai-compatible")

    expect(completionSpy).not.toHaveBeenCalled()
  })

  test("passes googleSearch-only request natively when messageApiWebSearchModel targets a Google provider", async () => {
    const googleWebSearchProvider: ResolvedProviderConfig = {
      name: "gemini-search",
      type: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-google-key",
      authType: "x-goog-api-key",
      models: {},
    }
    googleHandlerDependencies.getMessageApiWebSearchModel = () =>
      "gemini-search/gemini-2.5-flash"
    googleHandlerDependencies.resolveProviderConfig = (provider) =>
      Promise.resolve(
        provider === "gemini-search" ? googleWebSearchProvider : null,
      )
    const forward = mock<typeof originalForwardGoogle>(() =>
      Promise.resolve(
        Response.json({
          candidates: [
            {
              index: 0,
              content: { role: "model", parts: [{ text: "native result" }] },
              finishReason: "STOP",
              groundingMetadata: { webSearchQueries: ["native query"] },
            },
          ],
        }),
      ),
    )
    googleHandlerDependencies.forwardGoogleGenerateContent = forward

    const app = createServer()
    const response = await app.request(
      "/v1beta/models/gemini-3.8-flash:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "native query" }] }],
          tools: [{ googleSearch: {} }],
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(forward).toHaveBeenCalledTimes(1)
    expect(forward.mock.calls[0]?.[1]).toBe("gemini-2.5-flash")
    expect(forward.mock.calls[0]?.[2].tools).toEqual([{ googleSearch: {} }])
    const body = (await response.json()) as GoogleGenerateContentResponse
    expect(body.candidates?.[0]?.content?.parts).toEqual([
      { text: "native result" },
    ])
    expect(body.candidates?.[0]?.groundingMetadata).toEqual({
      webSearchQueries: ["native query"],
    })
  })

  test("emits empty SSE keepalive frames during silent translated streams without comments or synthetic JSON chunks", async () => {
    googleHandlerDependencies.sseKeepaliveIntervalMs = 20

    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms))
    const enc = new TextEncoder()
    const sseLine = (payload: Record<string, unknown>) =>
      enc.encode(`data: ${JSON.stringify(payload)}\n\n`)

    googleHandlerDependencies.handleCompletionPayload = mock(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              // Silent metadata-only events that yield no Google chunk
              controller.enqueue(
                sseLine({
                  type: "message_start",
                  message: {
                    id: "msg-keepalive-1",
                    type: "message",
                    role: "assistant",
                    model: "gemini-4-neon",
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 100, output_tokens: 0 },
                  },
                }),
              )
              controller.enqueue(sseLine({ type: "ping" }))
              await sleep(55)
              controller.enqueue(
                sseLine({
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "Hello" },
                }),
              )
              controller.enqueue(
                sseLine({
                  type: "content_block_stop",
                  index: 0,
                }),
              )
              // Mid-stream pause while buffering tool_use arguments
              controller.enqueue(
                sseLine({
                  type: "content_block_start",
                  index: 1,
                  content_block: {
                    type: "tool_use",
                    id: "call_1",
                    name: "read_file",
                    input: {},
                  },
                }),
              )
              controller.enqueue(
                sseLine({
                  type: "content_block_delta",
                  index: 1,
                  delta: {
                    type: "input_json_delta",
                    partial_json: '{"path":"a.ts"}',
                  },
                }),
              )
              await sleep(55)
              controller.enqueue(
                sseLine({
                  type: "content_block_stop",
                  index: 1,
                }),
              )
              controller.enqueue(
                sseLine({
                  type: "message_delta",
                  delta: { stop_reason: "tool_use", stop_sequence: null },
                  usage: { output_tokens: 12 },
                }),
              )
              controller.enqueue(sseLine({ type: "message_stop" }))
              controller.close()
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      ),
    )

    const app = createServer()
    const response = await app.request(
      "/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    )

    expect(response.status).toBe(200)
    const rawBody = await response.text()

    // Keepalive frames are emitted before the first chunk and during the mid-stream pause
    expect(rawBody.startsWith("\n\n")).toBe(true)
    expect(rawBody).toContain("\n\n\n\n")
    expect(rawBody).not.toContain(": keep-alive")
    expect(rawBody).not.toContain("event:")

    // Simulate google.golang.org/genai iterateResponseStream: split on "\n\n",
    // skip empty frames, and reject any non-"data:" frame.
    const frames = rawBody.split("\n\n")
    const emptyFrames = frames.filter((frame) => frame.length === 0)
    const nonEmptyFrames = frames.filter((frame) => frame.length > 0)
    expect(emptyFrames.length).toBeGreaterThanOrEqual(2)
    for (const frame of nonEmptyFrames) {
      expect(frame.startsWith("data:")).toBe(true)
    }

    // No synthetic empty JSON chunks are injected
    const parsedChunks = parseSseDataEvents(rawBody)
    expect(parsedChunks).toHaveLength(3)
    expect(parsedChunks[0]?.candidates?.[0]?.content?.parts).toEqual([
      { text: "Hello" },
    ])
    expect(parsedChunks[1]?.candidates?.[0]?.content?.parts).toEqual([
      {
        functionCall: {
          id: "call_1",
          name: "read_file",
          args: { path: "a.ts" },
        },
      },
    ])
    expect(parsedChunks[2]?.candidates?.[0]?.finishReason).toBe("STOP")
  })

  test("cancels idle translated SSE stream promptly on client abort during keepalive", async () => {
    googleHandlerDependencies.sseKeepaliveIntervalMs = 15

    let innerCancelled = false
    let resolveCancelled!: () => void
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve
    })

    googleHandlerDependencies.handleCompletionPayload = mock(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Stay completely silent after headers
            },
            cancel() {
              innerCancelled = true
              resolveCancelled()
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      ),
    )

    const abortController = new AbortController()
    const app = createServer()
    const response = await app.request(
      "/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
        signal: abortController.signal,
      },
    )

    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const firstRead = await reader.read()
    expect(new TextDecoder().decode(firstRead.value)).toBe("\n\n")

    abortController.abort()
    await reader.cancel()
    await cancelled
    expect(innerCancelled).toBe(true)
  })

  test("emits empty SSE keepalive frames on native Google passthrough without affecting first-token timing or non-SSE mode", async () => {
    googleHandlerDependencies.sseKeepaliveIntervalMs = 20

    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms))
    const enc = new TextEncoder()

    const googleProvider: ResolvedProviderConfig = {
      name: "mygoogle",
      type: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-google-key",
      authType: "x-goog-api-key",
      models: {},
    }
    googleHandlerDependencies.resolveConfiguredProviderModelAlias = () =>
      Promise.resolve({ provider: "mygoogle", model: "gemini-4-argon" })
    googleHandlerDependencies.resolveProviderConfig = (provider) =>
      Promise.resolve(provider === "mygoogle" ? googleProvider : null)

    let firstTokenMs: number | null = null
    let keepaliveDelayMs = 0
    googleHandlerDependencies.forwardGoogleGenerateContent = mock(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              const startedAt = performance.now()
              await sleep(55)
              keepaliveDelayMs = performance.now() - startedAt
              controller.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({
                    modelVersion: "gemini-4-argon",
                    candidates: [
                      {
                        index: 0,
                        content: { role: "model", parts: [{ text: "ok" }] },
                        finishReason: "STOP",
                      },
                    ],
                    usageMetadata: {
                      promptTokenCount: 10,
                      candidatesTokenCount: 2,
                      totalTokenCount: 12,
                    },
                  })}\n\n`,
                ),
              )
              controller.close()
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      ),
    )

    const plugins = new GatewayPlugins(4141)
    await plugins.register("first-token-observer", ({ on }) => {
      on("request.first_token", (event) => {
        firstTokenMs = event.firstTokenMs
      })
    })
    const app = createServer({ plugins })

    try {
      const sseRes = await app.request(
        "/v1beta/models/mygoogle/gemini-4-argon:streamGenerateContent?alt=sse",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "hello" }] }],
          }),
        },
      )
      expect(sseRes.status).toBe(200)
      const rawBody = await sseRes.text()
      expect(rawBody.startsWith("\n\n")).toBe(true)
      const chunks = parseSseDataEvents(rawBody)
      expect(chunks).toHaveLength(1)
      expect(chunks[0]?.candidates?.[0]?.content?.parts).toEqual([
        { text: "ok" },
      ])
      // Keepalive frames must not trigger first-token timing prematurely
      expect(firstTokenMs).not.toBeNull()
      expect(firstTokenMs ?? 0).toBeGreaterThanOrEqual(keepaliveDelayMs - 10)

      // Non-SSE JSON array mode returns a plain JSON array without keepalive frames
      const jsonRes = await app.request(
        "/v1beta/models/mygoogle/gemini-4-argon:streamGenerateContent",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "hello" }] }],
          }),
        },
      )
      expect(jsonRes.status).toBe(200)
      const jsonChunks =
        (await jsonRes.json()) as Array<GoogleGenerateContentResponse>
      expect(jsonChunks).toHaveLength(1)
      expect(jsonChunks[0]?.candidates?.[0]?.content?.parts).toEqual([
        { text: "ok" },
      ])
    } finally {
      await plugins.close()
    }
  })
})
