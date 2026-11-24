import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { ServerSentEventMessage } from "fetch-event-stream"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { ResolvedProviderConfig } from "~/lib/config"
import type { ChatCompletionChunk } from "~/lib/types/chat-completions"
import type {
  GoogleGenerateContentResponse,
  GoogleModelsResponse,
} from "~/lib/types/google"

process.env.COPILOT_API_HOME = mkdtempSync(
  path.join(tmpdir(), "copilot-api-google-endpoint-"),
)
process.env.COPILOT_API_SQLITE_DB_PATH = ":memory:"

const { createServer } = await import("~/server")
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
const originalHandleCompletionPayload =
  googleHandlerDependencies.handleCompletionPayload
const originalGetAggregatedModels =
  googleHandlerDependencies.getAggregatedModels
const originalResolveAlias =
  googleHandlerDependencies.resolveConfiguredProviderModelAlias
const originalResolveProvider = googleHandlerDependencies.resolveProviderConfig
const originalForwardGoogle =
  googleHandlerDependencies.forwardGoogleGenerateContent

const createChatCompletions = mock(originalCreateChatCompletions)
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
  messagesApiFlowDependencies.createChatCompletions = createChatCompletions
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
  test("parses standard v1beta, Vertex v1beta1, percent-encoded, and namespaced models", () => {
    expect(
      parseGoogleModelActionPath(
        "http://localhost/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
      ),
    ).toEqual({ model: "gemini-4-neon", action: "streamGenerateContent" })

    expect(
      parseGoogleModelActionPath(
        "http://localhost/v1beta1/projects/my-proj/locations/global/publishers/google/models/gemini-4-neon:generateContent",
      ),
    ).toEqual({ model: "gemini-4-neon", action: "generateContent" })

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
      "/v1beta1/projects/demo/locations/global/publishers/google/models/gemini-4-neon:generateContent",
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

  test("passes native google provider requests through directly for non-streaming, SSE, and JSON array", async () => {
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

    // 1. Non-streaming passthrough
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
    googleHandlerDependencies.forwardGoogleGenerateContent = mock(() =>
      Promise.resolve(Response.json(nativeResponse)),
    )

    const unaryRes = await app.request(
      "/v1beta/models/mygoogle/gemini-4-argon:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        }),
      },
    )
    expect(unaryRes.status).toBe(200)
    expect(await unaryRes.json()).toEqual(nativeResponse)

    // 2. SSE streaming passthrough
    const ssePayload = `data: ${JSON.stringify(nativeResponse)}\n\n`
    googleHandlerDependencies.forwardGoogleGenerateContent = mock(() =>
      Promise.resolve(
        new Response(ssePayload, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    )
    const sseRes = await app.request(
      "/v1beta/models/mygoogle/gemini-4-argon:streamGenerateContent?alt=sse",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Stream me" }] }],
        }),
      },
    )
    expect(sseRes.status).toBe(200)
    expect(parseSseDataEvents(await sseRes.text())).toEqual([nativeResponse])

    // 3. JSON array streaming passthrough (no alt=sse)
    googleHandlerDependencies.forwardGoogleGenerateContent = mock(() =>
      Promise.resolve(
        new Response(ssePayload, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    )
    const arrayRes = await app.request(
      "/v1beta/models/mygoogle/gemini-4-argon:streamGenerateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Array stream" }] }],
        }),
      },
    )
    expect(arrayRes.status).toBe(200)
    expect(await arrayRes.json()).toEqual([nativeResponse])
  })

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

    // Non-streaming request receiving SSE stream -> 502
    googleHandlerDependencies.handleCompletionPayload = mock(() =>
      Promise.resolve(
        new Response("data: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
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

  test("handles native google provider non-OK errors and non-SSE JSON fallback on streaming", async () => {
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

    // Upstream 503 forwarded through HTTPError
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

    // Upstream returns JSON array for streaming request (both SSE and non-SSE client modes)
    const chunk: GoogleGenerateContentResponse = {
      candidates: [
        {
          index: 0,
          content: { role: "model", parts: [{ text: "From JSON array" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
    }
    googleHandlerDependencies.forwardGoogleGenerateContent = mock(() =>
      Promise.resolve(Response.json([chunk])),
    )
    const sseFromJson = await app.request(
      "/v1beta/models/mygoogle/gemini-4-argon:streamGenerateContent?alt=sse",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    )
    expect(sseFromJson.status).toBe(200)
    expect(parseSseDataEvents(await sseFromJson.text())).toEqual([chunk])

    googleHandlerDependencies.forwardGoogleGenerateContent = mock(() =>
      Promise.resolve(Response.json([chunk])),
    )
    const arrayFromJson = await app.request(
      "/v1beta/models/mygoogle/gemini-4-argon:streamGenerateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    )
    expect(arrayFromJson.status).toBe(200)
    expect(await arrayFromJson.json()).toEqual([chunk])
  })
})
