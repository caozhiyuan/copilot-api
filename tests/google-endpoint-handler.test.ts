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
const originalResolveAlias =
  googleHandlerDependencies.resolveConfiguredProviderModelAlias
const originalResolveProvider = googleHandlerDependencies.resolveProviderConfig
const originalForwardGoogle =
  googleHandlerDependencies.forwardGoogleGenerateContent
const originalStateModels = state.models

const createChatCompletions = mock(originalCreateChatCompletions)
const createResponses = mock(originalCreateResponses)
const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

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
  googleHandlerDependencies.resolveConfiguredProviderModelAlias =
    originalResolveAlias
  googleHandlerDependencies.resolveProviderConfig = originalResolveProvider
  googleHandlerDependencies.forwardGoogleGenerateContent = originalForwardGoogle
})

afterEach(async () => {
  messagesApiFlowDependencies.createChatCompletions =
    originalCreateChatCompletions
  messagesApiFlowDependencies.createResponses = originalCreateResponses
  state.models = originalStateModels
  googleHandlerDependencies.handleCompletionPayload =
    originalHandleCompletionPayload
  googleHandlerDependencies.getAggregatedModels = originalGetAggregatedModels
  googleHandlerDependencies.resolveConfiguredProviderModelAlias =
    originalResolveAlias
  googleHandlerDependencies.resolveProviderConfig = originalResolveProvider
  googleHandlerDependencies.forwardGoogleGenerateContent = originalForwardGoogle
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
      thoughtSignature: opaqueToken,
    })
    expect(turn1Events[2]?.candidates?.[0]?.finishReason).toBe("STOP")

    // Turn 2: Client sends back the functionCall + thoughtSignature + functionResponse
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

    const turn2Res = await app.request(
      "/v1beta/models/gemini-4-neon:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: "Read README.md" }] },
            { role: "model", parts: [thoughtPart, callPart] },
            {
              role: "user",
              parts: [
                {
                  functionResponse: {
                    id: "call_read_1",
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
      if (toolPart) merged.push(toolPart)
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
})
