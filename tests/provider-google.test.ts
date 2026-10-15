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
import { modelsDevCatalogFixture } from "./fixtures/models-dev-catalog"

import {
  resolveProviderAuthType,
  resolveProviderConfigForModel,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { forwardError } from "~/lib/error"
import {
  getModelsDevProviderOptions,
  installModelsDevCatalog,
} from "~/lib/models-dev-cache"
import * as tokenUsage from "~/lib/token-usage"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
} from "~/lib/types/anthropic"
import type { ResponsesPayload } from "~/lib/types/responses"
import type { GoogleGenerateContentPayload } from "~/lib/types/google"
import { handleCompletion } from "~/routes/messages/handler"
import {
  handleProviderMessages,
  providerMessagesHandlerDependencies,
} from "~/routes/provider/messages/handler"
import {
  handleProviderResponsesForProvider,
  providerResponsesHandlerDependencies,
} from "~/routes/provider/responses/handler"
import {
  buildProviderUpstreamHeaders,
  forwardProviderModels,
  resolveProviderEndpointUrl,
} from "~/services/providers/provider-proxy"

const requestUrl = (value: string | URL | Request): string =>
  value instanceof Request ? value.url : value.toString()

const originalFetch = globalThis.fetch
const originalResolve =
  providerMessagesHandlerDependencies.resolveProviderConfig
const originalResponsesResolve =
  providerResponsesHandlerDependencies.resolveProviderConfig
let provider: ResolvedProviderConfig
const recordUsage = mock((_usage: tokenUsage.UsageTokens) => {})
let restoreRecorder = () => {}
const googleResponse = {
  responseId: "google-id",
  candidates: [
    {
      content: { role: "model", parts: [{ text: "hello" }] },
      finishReason: "STOP",
    },
  ],
  usageMetadata: {
    promptTokenCount: 20,
    cachedContentTokenCount: 5,
    candidatesTokenCount: 4,
    thoughtsTokenCount: 6,
  },
}
const fetchMock = mock(
  (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(Response.json(googleResponse)),
)
const sse = (chunks: Array<unknown>) =>
  new Response(
    chunks
      .map(
        (chunk) =>
          `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
const parseSse = (text: string): Array<AnthropicStreamEventData> =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as AnthropicStreamEventData)
const createApp = () => {
  const app = new Hono()
  app.onError((error, c) => forwardError(c, error))
  app.post("/:provider/v1/messages", handleProviderMessages)
  app.post("/v1/messages", handleCompletion)
  app.post(
    "/:provider/v1/responses",
    async (c) =>
      await handleProviderResponsesForProvider(c, {
        payload: await c.req.json<ResponsesPayload>(),
        provider: c.req.param("provider"),
      }),
  )
  return app
}
const send = (
  body: Partial<AnthropicMessagesPayload> = {},
  path = "/google/v1/messages",
) =>
  createApp().request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "client-secret",
    },
    body: JSON.stringify({
      model: "gemini-3.8-flash",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
      ...body,
    }),
  })

beforeEach(() => {
  provider = {
    name: "google",
    type: "google",
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "google-key",
    authType: "x-goog-api-key",
  }
  providerMessagesHandlerDependencies.resolveProviderConfig = () =>
    Promise.resolve(provider)
  providerResponsesHandlerDependencies.resolveProviderConfig = () =>
    Promise.resolve(provider)
  const recorderSpy = spyOn(
    tokenUsage,
    "createProviderTokenUsageRecorder",
  ).mockImplementation(() => recordUsage)
  restoreRecorder = () => recorderSpy.mockRestore()
  recordUsage.mockClear()
  fetchMock.mockReset()
  fetchMock.mockImplementation(() =>
    Promise.resolve(Response.json(googleResponse)),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  providerMessagesHandlerDependencies.resolveProviderConfig = originalResolve
  providerResponsesHandlerDependencies.resolveProviderConfig =
    originalResponsesResolve
  restoreRecorder()
})

describe("Google provider configuration and discovery", () => {
  test("uses Google authentication defaults without forwarding client credentials or Anthropic headers", () => {
    expect(resolveProviderAuthType("google", undefined, "google")).toBe(
      "x-goog-api-key",
    )
    expect(resolveProviderAuthType("google", "x-goog-api-key", "google")).toBe(
      "x-goog-api-key",
    )
    expect(resolveProviderAuthType("google", "invalid", "google")).toBe(
      "x-goog-api-key",
    )
    const headers = buildProviderUpstreamHeaders(
      provider,
      new Headers({
        "x-api-key": "client-key",
        "x-goog-api-key": "client-google-key",
        authorization: "Bearer client-token",
        "anthropic-beta": "beta",
        "anthropic-version": "2023-06-01",
      }),
    )
    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      "x-goog-api-key": "google-key",
    })
  })
  test.each([
    ["https://google.example", "https://google.example/v1beta/models"],
    ["https://google.example/v1beta/", "https://google.example/v1beta/models"],
    [
      "https://google.example/proxy/v1",
      "https://google.example/proxy/v1/models",
    ],
    ["https://google.example/v1alpha", "https://google.example/v1alpha/models"],
  ])("resolves native Google endpoint %s", (baseUrl, expected) => {
    expect(resolveProviderEndpointUrl({ ...provider, baseUrl }, "models")).toBe(
      expected,
    )
  })
  test("recognizes selected Google models.dev providers and per-model protocol overrides", () => {
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      google: {
        npm: "@ai-sdk/google",
        api: "https://google.example/v1beta",
        models: { "gemini-test": { id: "gemini-test" } },
      },
    })
    expect(getModelsDevProviderOptions()).toContainEqual({
      id: "google",
      name: "google",
      api: "https://google.example/v1beta",
      type: "google",
    })
    const resolved = resolveProviderConfigForModel(
      {
        ...provider,
        name: "custom",
        type: "anthropic",
        authType: "x-api-key",
        models: { "gemini-test": { type: "google" } },
      },
      "gemini-test",
    )
    expect(resolved.type).toBe("google")
    expect(resolved.authType).toBe("x-goog-api-key")
  })
  test("normalizes paginated native model lists and excludes embedding-only models", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json({
          models: [
            {
              name: "models/gemini-a",
              displayName: "Gemini A",
              inputTokenLimit: 100000,
              outputTokenLimit: 8192,
              supportedGenerationMethods: ["generateContent"],
            },
            {
              name: "models/embedding",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
          nextPageToken: "page-two",
        }),
      ),
    )
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json({
          models: [
            {
              name: "models/gemini-b",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        }),
      ),
    )
    const response = await forwardProviderModels(provider, new Headers())
    const body = (await response.json()) as {
      data: Array<Record<string, unknown>>
      has_more: boolean
    }
    expect(body.data.map((model) => model.id)).toEqual(["gemini-a", "gemini-b"])
    expect(body.data[0]).toMatchObject({
      context_window: 100000,
      max_output_tokens: 8192,
      display_name: "Gemini A",
    })
    expect(body.has_more).toBe(false)
    expect(
      new URL(requestUrl(fetchMock.mock.calls[1][0])).searchParams.get(
        "pageToken",
      ),
    ).toBe("page-two")
  })
  test("passes model-list errors through and rejects repeated pagination tokens", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ error: "denied" }, { status: 403 })),
    )
    expect((await forwardProviderModels(provider, new Headers())).status).toBe(
      403,
    )
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ nextPageToken: "again" })),
    )
    const result = await forwardProviderModels(provider, new Headers()).catch(
      (error: unknown) => error,
    )
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain("repeated page token")
  })
})

describe("Google Messages routes", () => {
  test("forwards a prefixed Messages request with model defaults and records all usage", async () => {
    provider.models = {
      "gemini-3.8-flash": {
        temperature: 0.2,
        topK: 20,
        topP: 0.8,
        extraBody: {
          cachedContent: "cachedContents/test",
          generationConfig: {
            temperature: 0.9,
            responseMimeType: "application/json",
          },
        },
      },
    }
    const response = await send({ system: "Be brief" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      type: "message",
      model: "gemini-3.8-flash",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 15,
        cache_read_input_tokens: 5,
        output_tokens: 10,
      },
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(requestUrl(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    )
    expect(init?.headers).toMatchObject({
      "x-goog-api-key": "google-key",
      accept: "application/json",
    })
    const body = JSON.parse(
      init?.body as string,
    ) as GoogleGenerateContentPayload
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: "Be brief" }] },
      cachedContent: "cachedContents/test",
      generationConfig: {
        temperature: 0.2,
        topK: 20,
        topP: 0.8,
        maxOutputTokens: 100,
        responseMimeType: "application/json",
      },
    })
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        input_tokens: 15,
        cache_read_input_tokens: 5,
        output_tokens: 10,
      }),
    )
  })
  test("routes top-level provider/model aliases and model-level Google overrides", async () => {
    provider = {
      ...provider,
      type: "anthropic",
      authType: "x-api-key",
      models: { "gemini-3.8-flash": { type: "google" } },
    }
    const response = await send(
      { model: "google/gemini-3.8-flash" },
      "/v1/messages",
    )
    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls[0][1]?.headers).toHaveProperty(
      "x-goog-api-key",
      "google-key",
    )
    expect(requestUrl(fetchMock.mock.calls[0][0])).toContain(
      "gemini-3.8-flash:generateContent",
    )
    expect(fetchMock.mock.calls[0][1]?.body as string).not.toContain(
      "google/gemini-3.8-flash",
    )
  })
  test("supports the existing Responses-to-Messages bridge for Google providers", async () => {
    const response = await createApp().request("/google/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        input: "hello",
        max_output_tokens: 100,
        stream: false,
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      object: "response",
      status: "completed",
    })
    expect(requestUrl(fetchMock.mock.calls[0][0])).toContain(":generateContent")
  })
  test.each([
    { model: "gemini-3.8-flash", effort: "low", expected: "LOW" as const },
    {
      model: "gemini-3.8-flash",
      effort: "medium",
      expected: "MEDIUM" as const,
    },
    { model: "gemini-4-argon", effort: "low", expected: "LOW" as const },
    { model: "gemini-4-argon", effort: "medium", expected: "MEDIUM" as const },
  ])(
    "preserves Responses reasoning effort $effort through the Google adapter",
    async ({ model, effort, expected }) => {
      const response = await createApp().request("/google/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          input: "hello",
          max_output_tokens: 100,
          reasoning: { effort },
          stream: false,
        }),
      })
      expect(response.status).toBe(200)
      const body = JSON.parse(
        fetchMock.mock.calls[0][1]?.body as string,
      ) as GoogleGenerateContentPayload
      expect(body.generationConfig.thinkingConfig).toEqual({
        includeThoughts: true,
        thinkingLevel: expected,
      })
    },
  )

  test("routes a mixed-protocol catalog's Google model to its native model API URL", async () => {
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      mixed: {
        npm: "@ai-sdk/openai-compatible",
        api: "https://mixed.example/v1",
        models: {
          "gemini-3.8-flash": {
            id: "gemini-3.8-flash",
            provider: {
              npm: "@ai-sdk/google",
              api: "https://mixed.example/google/v1beta",
            },
          },
        },
      },
    })
    provider = {
      ...provider,
      name: "mixed",
      type: "openai-compatible",
      authType: "authorization",
      modelsDevProviderId: "mixed",
      baseUrl: "https://mixed.example/v1",
    }
    const response = await send({ model: "gemini-3.8-flash" })
    expect(response.status).toBe(200)
    expect(requestUrl(fetchMock.mock.calls[0][0])).toBe(
      "https://mixed.example/google/v1beta/models/gemini-3.8-flash:generateContent",
    )
    expect(fetchMock.mock.calls[0][1]?.headers).toHaveProperty(
      "x-goog-api-key",
      "google-key",
    )
  })

  test("links screenshot tool results to stable, unique inline media names", async () => {
    const messages: AnthropicMessagesPayload["messages"] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "screenshot-1", name: "browser", input: {} },
          { type: "tool_use", id: "screenshot-2", name: "browser", input: {} },
        ],
      },
      {
        role: "user",
        content: ["screenshot-1", "screenshot-2"].map((tool_use_id) => ({
          type: "tool_result" as const,
          tool_use_id,
          content: [
            { type: "text" as const, text: "Screenshot taken" },
            {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: "image/png" as const,
                data: "aW1n",
              },
            },
          ],
        })),
      },
    ]
    expect((await send({ model: "gemini-3.8-flash", messages })).status).toBe(
      200,
    )
    const body = JSON.parse(
      fetchMock.mock.calls[0][1]?.body as string,
    ) as GoogleGenerateContentPayload
    const responses = body.contents[1].parts.map(
      (part) => part.functionResponse!,
    )
    const names = responses.map(
      (response) => response.parts![0].inlineData!.displayName,
    )
    expect(new Set(names).size).toBe(2)
    for (const response of responses) {
      expect(response.response).toEqual({
        output: {
          text: "Screenshot taken",
          media: [{ $ref: response.parts![0].inlineData!.displayName }],
        },
      })
      expect(response.parts![0].inlineData).toMatchObject({
        mimeType: "image/png",
        data: "aW1n",
      })
    }
    await send({ model: "gemini-3.8-flash", messages })
    expect(fetchMock.mock.calls[1][1]?.body).toBe(
      fetchMock.mock.calls[0][1]?.body,
    )
  })

  test("avoids double models/ prefixes and escapes model IDs in upstream URLs", async () => {
    await send({ model: "models/gemini-test" })
    expect(requestUrl(fetchMock.mock.calls[0][0])).toContain(
      "/models/gemini-test:generateContent",
    )
    await send({ model: "gemini?key=unexpected" })
    const url = new URL(requestUrl(fetchMock.mock.calls[1][0]))
    expect(url.search).toBe("")
    expect(url.pathname).toContain("gemini%3Fkey%3Dunexpected")
  })
  test("preserves upstream HTTP errors and retry headers", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json(
          { error: { message: "quota exceeded" } },
          { status: 429, headers: { "retry-after": "10" } },
        ),
      ),
    )
    const response = await send()
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("10")
    expect(await response.text()).toContain("quota exceeded")
    expect(recordUsage).not.toHaveBeenCalled()
  })
  test("streams SSE events and retains usage-only chunks after the finish reason", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        sse([
          "",
          {
            responseId: "sse-id",
            candidates: [{ content: { parts: [{ text: "hel" }] } }],
          },
          {
            candidates: [
              { content: { parts: [{ text: "lo" }] }, finishReason: "STOP" },
            ],
          },
          { usageMetadata: googleResponse.usageMetadata },
          "[DONE]",
        ]),
      ),
    )
    const response = await send({ stream: true })
    const events = parseSse(await response.text())
    expect(new URL(requestUrl(fetchMock.mock.calls[0][0])).search).toBe(
      "?alt=sse",
    )
    expect(requestUrl(fetchMock.mock.calls[0][0])).toContain(
      ":streamGenerateContent",
    )
    expect(fetchMock.mock.calls[0][1]?.headers).toHaveProperty(
      "accept",
      "text/event-stream",
    )
    expect(events[0]).toMatchObject({
      type: "message_start",
      message: { id: "sse-id" },
    })
    expect(events.at(-2)).toMatchObject({
      type: "message_delta",
      usage: {
        input_tokens: 15,
        output_tokens: 10,
        cache_read_input_tokens: 5,
      },
    })
    expect(events.at(-1)).toEqual({ type: "message_stop" })
    expect(recordUsage).toHaveBeenCalledTimes(1)
  })
  test("can synthesize a client stream when the upstream returns JSON", async () => {
    const response = await send({ stream: true })
    expect(parseSse(await response.text()).at(-1)).toEqual({
      type: "message_stop",
    })
  })
  test.each(["truncated", "error", "invalid-json"])(
    "emits an error without success completion for %s streams",
    async (failure) => {
      const chunk = {
        candidates: [{ content: { parts: [{ text: "partial" }] } }],
        usageMetadata: { promptTokenCount: 8 },
      }
      fetchMock.mockImplementationOnce(() =>
        Promise.resolve(
          sse([
            chunk,
            ...(failure === "error" ? [{ error: { message: "overloaded" } }]
            : failure === "invalid-json" ? ["bad-json"]
            : []),
          ]),
        ),
      )
      const events = parseSse(await (await send({ stream: true })).text())
      expect(events.at(-1)).toMatchObject({ type: "error" })
      expect(events.some((event) => event.type === "message_stop")).toBe(false)
      expect(recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ input_tokens: 8 }),
      )
    },
  )
  test("cancels the upstream body when the client disconnects", async () => {
    let cancelled = false
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })}\n\n`,
                ),
              )
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    )
    const response = await send({ stream: true })
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let received = ""
    while (!received.includes("text_delta")) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += decoder.decode(chunk.value)
    }
    // Disconnect after all available events were consumed, while the next
    // upstream read is pending rather than between completed SSE events.
    await Bun.sleep(10)
    await reader.cancel()
    for (
      let attempt = 0;
      attempt < 50 && (!cancelled || recordUsage.mock.calls.length === 0);
      attempt++
    )
      await Bun.sleep(5)
    expect(cancelled).toBe(true)
    expect(recordUsage).toHaveBeenCalledTimes(1)
  })
  test("returns a bad request for unmatched tool results", async () => {
    const response = await send({
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "missing", content: "result" },
          ],
        },
      ],
    })
    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await response.json()) as AnthropicResponse).toHaveProperty("error")
  })
})
