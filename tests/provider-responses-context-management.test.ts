import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import { MODEL_NOT_ALLOWED_ERROR } from "~/lib/model-admission"
import { state } from "~/lib/state"
import type { ResponsesResult } from "~/lib/types/responses"

let providerConfig: ResolvedProviderConfig | null = null

const { closeUsageStore } = await import("~/lib/token-usage")
const { responsesRoutes } = await import("~/routes/responses/route")
const { providerResponsesRoutes } = await import(
  "~/routes/provider/responses/route"
)
const { providerMessagesHandlerDependencies } = await import(
  "~/routes/provider/messages/handler"
)
const { providerResponsesHandlerDependencies } = await import(
  "~/routes/provider/responses/handler"
)
const { responsesHandlerDependencies } = await import(
  "~/routes/responses/handler"
)
const { responsesUtilsDependencies } = await import("~/routes/responses/utils")

const defaultProviderMessagesHandlerDependencies = {
  ...providerMessagesHandlerDependencies,
}
const defaultProviderResponsesHandlerDependencies = {
  ...providerResponsesHandlerDependencies,
}
const defaultResponsesHandlerDependencies = { ...responsesHandlerDependencies }
const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }
const originalFetch = globalThis.fetch

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

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

const parseJsonRequestBody = (body: unknown): unknown => {
  if (typeof body !== "string") {
    throw new Error("Expected JSON string request body")
  }

  return JSON.parse(body) as unknown
}

const defaultFetchImplementation = (
  _url: string | URL | Request,
  init?: RequestInit,
) => {
  const body = parseJsonRequestBody(init?.body) as { model: string }
  return Promise.resolve(
    new Response(JSON.stringify(createResponsesResult(body.model)), {
      headers: {
        "content-type": "application/json",
      },
    }),
  )
}

const fetchMock = mock(defaultFetchImplementation)

const createApp = () => {
  const app = new Hono()
  app.route("/v1/responses", responsesRoutes)
  app.route("/:provider/v1/responses", providerResponsesRoutes)
  return app
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()

  providerConfig = {
    apiKey: "provider-key",
    authType: "authorization",
    baseUrl: "https://openai-responses.example",
    models: {
      "gpt-test": {},
    },
    name: "openai",
    type: "openai-responses",
  }

  const resolveProviderConfig = () => Promise.resolve(providerConfig)
  providerMessagesHandlerDependencies.resolveProviderConfig =
    resolveProviderConfig
  providerResponsesHandlerDependencies.resolveProviderConfig =
    resolveProviderConfig
  responsesHandlerDependencies.resolveMappedModel = (model) => model
  responsesUtilsDependencies.getModelResponsesApiCompactThreshold = () =>
    undefined
  responsesUtilsDependencies.isContextManagementEnabledForMessages = () => true
  responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
    false
  fetchMock.mockImplementation(defaultFetchImplementation)
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(async () => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfig = null
  Object.assign(
    providerMessagesHandlerDependencies,
    defaultProviderMessagesHandlerDependencies,
  )
  Object.assign(
    providerResponsesHandlerDependencies,
    defaultProviderResponsesHandlerDependencies,
  )
  Object.assign(
    responsesHandlerDependencies,
    defaultResponsesHandlerDependencies,
  )
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)

  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
})

describe("provider Responses context management", () => {
  test("does not add context management or compact provider Responses input by default", async () => {
    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "older",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: "latest",
            role: "user",
          },
        ],
        model: "openai/gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      context_management?: unknown
      input: Array<unknown>
    }

    expect(body.context_management).toBeUndefined()
    expect(body.input).toHaveLength(3)
  })

  test("adds context management and keeps only the latest compaction carrier when enabled", async () => {
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "older",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: "latest",
            role: "user",
          },
        ],
        model: "openai/gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      context_management?: unknown
      input: Array<Record<string, unknown>>
    }

    expect(body.context_management).toEqual([
      {
        compact_threshold: 160000,
        type: "compaction",
      },
    ])
    expect(body.input).toEqual([
      {
        encrypted_content: "cipher",
        id: "compaction-1",
        type: "compaction",
      },
      {
        content: "latest",
        role: "user",
      },
    ])
  })

  test("does not add context management for non-GPT Responses models", async () => {
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "older",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: "latest",
            role: "user",
          },
        ],
        model: "microsoft/mai-1-preview",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      context_management?: unknown
      input: Array<unknown>
    }

    expect(body.context_management).toBeUndefined()
    expect(body.input).toHaveLength(3)
  })

  test("normalizes MAI effort across the Codex Messages fallback", async () => {
    providerConfig = {
      apiKey: "provider-key",
      authType: "authorization",
      baseUrl: "https://openai-responses.example",
      models: {
        "mai-1-preview": {
          reasoningEfforts: ["low", "high"],
        },
      },
      name: "opencode-go",
      type: "openai-responses",
    }

    const app = createApp()
    const response = await app.request("/opencode-go/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "mai-1-preview",
        reasoning: { effort: "max" },
      }),
      headers: {
        "content-type": "application/json",
        "user-agent": "codex-cli/1.0.0",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      reasoning?: { effort?: string }
    }
    expect(body.reasoning?.effort).toBe("high")
  })

  for (const effort of ["none", "low", "max", "turbo"] as const) {
    test(`preserves ${effort} when provider capabilities are unknown`, async () => {
      const app = createApp()
      const response = await app.request("/openai/v1/responses", {
        body: JSON.stringify({
          input: "hello",
          model: "gpt-test",
          reasoning: { effort },
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      })

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      const [, init] = fetchMock.mock.calls[0]
      const body = parseJsonRequestBody((init as RequestInit).body) as {
        reasoning?: { effort?: string }
      }
      expect(body.reasoning?.effort).toBe(effort)
    })
  }

  test("disables context management for gpt-5.6 models even when responses is enabled", async () => {
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "older",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: "latest",
            role: "user",
          },
        ],
        model: "openai/gpt-5.6-sol",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      context_management?: unknown
      input: Array<unknown>
    }

    expect(body.context_management).toBeUndefined()
    expect(body.input).toHaveLength(3)
  })

  test("disables context management for gpt-6 models even when responses is enabled", async () => {
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "older",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: "latest",
            role: "user",
          },
        ],
        model: "openai/gpt-6",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      context_management?: unknown
      input: Array<unknown>
    }

    expect(body.context_management).toBeUndefined()
    expect(body.input).toHaveLength(3)
  })

  test("rejects disallowed provider Responses fallback models", async () => {
    const response = await createApp().request("/openai/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
        models: ["gpt-test", "claude-sonnet-4"],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: MODEL_NOT_ALLOWED_ERROR })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("supports the provider-scoped responses route", async () => {
    const app = createApp()
    const response = await app.request("/openai/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://openai-responses.example/v1/responses",
    )

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      model: string
    }
    expect(body.model).toBe("gpt-test")
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })

  test("forwards safe Codex HTTP response headers", async () => {
    const originalCodexAccessToken = state.codexAccessToken
    const originalCodexAccountId = state.codexAccountId
    providerConfig = {
      apiKey: "",
      authType: "oauth2",
      baseUrl: "https://chatgpt.example/backend-api",
      models: { "gpt-test": {} },
      name: "codex",
      type: "openai-responses",
    }
    state.codexAccessToken = "synthetic-codex-token"
    state.codexAccountId = "synthetic-account"
    fetchMock.mockImplementation((_url, init) => {
      const body = parseJsonRequestBody(init?.body) as { model: string }
      const headers = new Headers({
        connection: "keep-alive",
        "content-encoding": "gzip",
        "content-length": "9999",
        "openai-processing-ms": "42",
        "transfer-encoding": "chunked",
        "x-codex-turn-state": "turn-state-http-123",
        "x-models-etag": 'W/"models-http-123"',
        "x-request-id": "request-http-123",
      })
      headers.append("set-cookie", "session=a; Path=/")
      headers.append("set-cookie", "affinity=b; Path=/")
      return Promise.resolve(
        new Response(JSON.stringify(createResponsesResult(body.model)), {
          headers,
        }),
      )
    })

    try {
      const response = await createApp().request("/codex/v1/responses", {
        body: JSON.stringify({ input: "hello", model: "gpt-test" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })

      expect(response.status).toBe(200)
      expect(response.headers.get("x-codex-turn-state")).toBe(
        "turn-state-http-123",
      )
      expect(response.headers.get("x-models-etag")).toBe('W/"models-http-123"')
      expect(response.headers.get("x-request-id")).toBe("request-http-123")
      expect(response.headers.get("openai-processing-ms")).toBe("42")
      expect(response.headers.getSetCookie()).toEqual([
        "session=a; Path=/",
        "affinity=b; Path=/",
      ])
      expect(response.headers.has("connection")).toBe(false)
      expect(response.headers.has("content-encoding")).toBe(false)
      expect(response.headers.has("content-length")).toBe(false)
      expect(response.headers.has("transfer-encoding")).toBe(false)
    } finally {
      state.codexAccessToken = originalCodexAccessToken
      state.codexAccountId = originalCodexAccountId
    }
  })

  test("does not forward Codex HTTP response headers on upstream errors", async () => {
    const originalCodexAccessToken = state.codexAccessToken
    const originalCodexAccountId = state.codexAccountId
    providerConfig = {
      apiKey: "",
      authType: "oauth2",
      baseUrl: "https://chatgpt.example/backend-api",
      models: { "gpt-test": {} },
      name: "codex",
      type: "openai-responses",
    }
    state.codexAccessToken = "synthetic-codex-token"
    state.codexAccountId = "synthetic-account"
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response("upstream denied", {
          headers: {
            "set-cookie": "upstream-session=secret; Path=/",
            "www-authenticate": "Bearer realm=upstream",
            "x-upstream-private": "do-not-forward",
          },
          status: 401,
        }),
      ),
    )

    try {
      const response = await createApp().request("/codex/v1/responses", {
        body: JSON.stringify({ input: "hello", model: "gpt-test" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })

      expect(response.status).toBe(401)
      expect(response.headers.get("set-cookie")).toBeNull()
      expect(response.headers.get("www-authenticate")).toBeNull()
      expect(response.headers.get("x-upstream-private")).toBeNull()
    } finally {
      state.codexAccessToken = originalCodexAccessToken
      state.codexAccountId = originalCodexAccountId
    }
  })

  test("keeps codex-prefixed provider models on the native Responses route for Codex clients", async () => {
    providerConfig = {
      apiKey: "provider-key",
      authType: "authorization",
      baseUrl: "https://openai-responses.example",
      models: {
        "codex-mini-latest": {},
      },
      name: "openai",
      type: "openai-responses",
    }

    const response = await createApp().request("/openai/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "codex-mini-latest",
      }),
      headers: {
        "content-type": "application/json",
        "user-agent": "codex-cli/1.0.0",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      input: unknown
      model: string
    }
    expect(body).toMatchObject({
      input: "hello",
      model: "codex-mini-latest",
    })
  })

  test("drains provider-scoped requests after client cancellation", async () => {
    let upstreamSignal: AbortSignal | undefined
    const upstreamStarted = createDeferred()
    const upstreamCompletion = createResponseDeferred()
    fetchMock.mockImplementation((_url, init) => {
      const signal = init?.signal
      if (!(signal instanceof AbortSignal)) {
        throw new Error("Expected upstream abort signal")
      }
      upstreamSignal = signal
      upstreamStarted.resolve()
      return upstreamCompletion.promise
    })
    const controller = new AbortController()
    const responsePromise = createApp().fetch(
      new Request("http://localhost/openai/v1/responses", {
        body: JSON.stringify({ input: "hello", model: "gpt-test" }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      }),
    )
    await upstreamStarted.promise

    controller.abort()
    expect(upstreamSignal?.aborted).toBe(false)
    upstreamCompletion.resolve(createJsonResponsesResponse("gpt-test"))

    const response = await responsePromise
    expect(response.status).toBe(200)
    expect(upstreamSignal?.aborted).toBe(false)
  })

  test("drains provider-prefixed Codex requests after client cancellation", async () => {
    const originalCodexAccessToken = state.codexAccessToken
    const originalCodexAccountId = state.codexAccountId
    let upstreamSignal: AbortSignal | undefined
    const upstreamStarted = createDeferred()
    const upstreamCompletion = createResponseDeferred()
    providerConfig = {
      apiKey: "",
      authType: "oauth2",
      baseUrl: "https://chatgpt.example/backend-api",
      models: { "gpt-test": {} },
      name: "codex",
      type: "openai-responses",
    }
    state.codexAccessToken = "synthetic-codex-token"
    state.codexAccountId = "synthetic-account"
    fetchMock.mockImplementation((url, init) => {
      expect(url).toBe("https://chatgpt.example/backend-api/codex/responses")
      const signal = init?.signal
      if (!(signal instanceof AbortSignal)) {
        throw new Error("Expected upstream abort signal")
      }
      upstreamSignal = signal
      upstreamStarted.resolve()
      return upstreamCompletion.promise
    })

    try {
      const controller = new AbortController()
      const responsePromise = createApp().fetch(
        new Request("http://localhost/codex/v1/responses", {
          body: JSON.stringify({ input: "hello", model: "gpt-test" }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: controller.signal,
        }),
      )
      await upstreamStarted.promise

      controller.abort()
      expect(upstreamSignal?.aborted).toBe(false)
      upstreamCompletion.resolve(createJsonResponsesResponse("gpt-test"))

      const response = await responsePromise
      expect(response.status).toBe(200)
      expect(upstreamSignal?.aborted).toBe(false)
    } finally {
      state.codexAccessToken = originalCodexAccessToken
      state.codexAccountId = originalCodexAccountId
    }
  })

  test("adapts Responses Lite through Messages to Chat Completions", async () => {
    providerConfig = {
      apiKey: "provider-key",
      authType: "authorization",
      baseUrl: "https://openai-chat.example",
      models: { "mai-chat-test": {} },
      name: "openai",
      type: "openai-compatible",
    }
    fetchMock.mockImplementation((_url, init) => {
      const body = parseJsonRequestBody(init?.body) as {
        model: string
        tools: Array<{
          type: string
          function: { name: string; strict?: boolean }
        }>
      }
      expect(body.model).toBe("mai-chat-test")
      expect(body.tools.map((tool) => tool.function.name)).toEqual([
        "apply_patch",
        "workspace__read_file",
      ])
      expect(body.tools[0]?.function.strict).toBe(true)
      return Promise.resolve(
        Response.json({
          id: "chatcmpl-lite",
          object: "chat.completion",
          created: 1,
          model: "mai-chat-test",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-patch",
                    type: "function",
                    function: {
                      name: "apply_patch",
                      arguments: JSON.stringify({
                        input: "*** Begin Patch",
                      }),
                    },
                  },
                  {
                    id: "call-read",
                    type: "function",
                    function: {
                      name: "workspace__read_file",
                      arguments: JSON.stringify({ path: "README.md" }),
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 6,
            total_tokens: 18,
          },
        }),
      )
    })

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        model: "openai/mai-chat-test",
        input: [
          {
            role: "developer",
            type: "additional_tools",
            tools: [
              { type: "custom", name: "apply_patch" },
              {
                type: "namespace",
                name: "workspace",
                tools: [
                  {
                    type: "function",
                    name: "read_file",
                    parameters: {
                      type: "object",
                      properties: { path: { type: "string" } },
                    },
                    strict: false,
                  },
                ],
              },
            ],
          },
          { type: "message", role: "user", content: "Update and read" },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://openai-chat.example/v1/chat/completions",
    )
    const body = (await response.json()) as ResponsesResult
    expect(body.model).toBe("openai/mai-chat-test")
    expect(body.output).toMatchObject([
      {
        type: "custom_tool_call",
        call_id: "call-patch",
        name: "apply_patch",
        input: "*** Begin Patch",
      },
      {
        type: "function_call",
        call_id: "call-read",
        name: "read_file",
        namespace: "workspace",
        arguments: JSON.stringify({ path: "README.md" }),
      },
    ])
  })

  test("applies strict to custom tools for the Kimi provider", async () => {
    providerConfig = {
      apiKey: "provider-key",
      authType: "authorization",
      baseUrl: "https://kimi.example",
      models: { k3: {} },
      name: "kimi",
      type: "openai-compatible",
    }
    fetchMock.mockImplementation((_url, init) => {
      const body = parseJsonRequestBody(init?.body) as {
        tools: Array<{
          function: Record<string, unknown>
          type: string
        }>
      }
      expect(body.tools).toHaveLength(1)
      expect(body.tools[0]?.function).toMatchObject({ name: "apply_patch" })
      expect(body.tools[0]?.function.strict).toBe(true)
      return Promise.resolve(
        Response.json({
          id: "chatcmpl-kimi",
          object: "chat.completion",
          created: 1,
          model: "k3",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "done" },
            },
          ],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 1,
            total_tokens: 5,
          },
        }),
      )
    })

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        model: "kimi/mai-1-preview",
        input: [
          {
            role: "developer",
            type: "additional_tools",
            tools: [{ type: "custom", name: "apply_patch" }],
          },
          { type: "message", role: "user", content: "Update the file" },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://kimi.example/v1/chat/completions",
    )
  })

  test("adapts Responses Lite directly to an Anthropic Messages provider", async () => {
    providerConfig = {
      apiKey: "provider-key",
      authType: "x-api-key",
      baseUrl: "https://anthropic.example",
      models: { "mai-test": {} },
      name: "anthropic",
      type: "anthropic",
    }
    fetchMock.mockImplementation((_url, init) => {
      const body = parseJsonRequestBody(init?.body) as {
        model: string
        tools: Array<{ name: string }>
      }
      expect(body.model).toBe("mai-test")
      expect(body.tools.map((tool) => tool.name)).toEqual(["apply_patch"])
      return Promise.resolve(
        Response.json({
          content: [
            {
              type: "tool_use",
              id: "call-patch",
              name: "apply_patch",
              input: { input: "*** Begin Patch" },
            },
          ],
          id: "msg-lite",
          model: "mai-test",
          role: "assistant",
          stop_reason: "tool_use",
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 9, output_tokens: 4 },
        }),
      )
    })

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        model: "anthropic/mai-test",
        input: [
          {
            role: "developer",
            type: "additional_tools",
            tools: [{ type: "custom", name: "apply_patch" }],
          },
          { type: "message", role: "user", content: "Patch it" },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://anthropic.example/v1/messages",
    )
    const body = (await response.json()) as ResponsesResult
    expect(body.model).toBe("anthropic/mai-test")
    expect(body.output[0]).toMatchObject({
      type: "custom_tool_call",
      call_id: "call-patch",
      name: "apply_patch",
      input: "*** Begin Patch",
    })
  })
})

describe("provider Responses reasoning transport isolation", () => {
  test("keeps only Messages reasoning when falling back to an Anthropic provider", async () => {
    providerConfig = {
      apiKey: "provider-key",
      authType: "x-api-key",
      baseUrl: "https://anthropic.example",
      models: { "mai-test": {} },
      name: "anthropic",
      type: "anthropic",
    }
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        Response.json({
          content: [{ type: "text", text: "done" }],
          id: "msg-switch",
          model: "mai-test",
          role: "assistant",
          stop_reason: "end_turn",
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 8, output_tokens: 2 },
        }),
      ),
    )

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        model: "anthropic/mai-test",
        input: [
          {
            id: "rs_native",
            type: "reasoning",
            summary: [],
            encrypted_content: "native-reasoning",
          },
          { role: "assistant", type: "message", content: "Visible answer" },
          {
            id: "rs_messages__a1",
            type: "reasoning",
            summary: [],
            encrypted_content: "messages-reasoning",
          },
          { role: "user", type: "message", content: "Continue" },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] ?? []
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      messages: Array<{ content: unknown }>
    }
    const blocks = body.messages.flatMap((message) =>
      Array.isArray(message.content) ?
        (message.content as Array<Record<string, unknown>>)
      : [],
    )
    const signatures = blocks
      .filter((block) => block.type === "thinking")
      .map((block) => block.signature)
    expect(signatures).toEqual(["messages-reasoning"])
    expect(blocks).toContainEqual({ type: "text", text: "Visible answer" })
  })

  test("drops Messages reasoning when forwarding to an openai-responses provider", async () => {
    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        model: "openai/gpt-test",
        input: [
          {
            id: "rs_native",
            type: "reasoning",
            summary: [],
            encrypted_content: "native-reasoning",
          },
          {
            id: "rs_messages__a1",
            type: "reasoning",
            summary: [],
            encrypted_content: "messages-reasoning",
          },
          { role: "user", type: "message", content: "Continue" },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] ?? []
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      input: Array<Record<string, unknown>>
    }
    const reasoningIds = body.input
      .filter((item) => item.type === "reasoning")
      .map((item) => item.id)
    expect(reasoningIds).toEqual(["rs_native"])
  })
})

const createDeferred = (): {
  promise: Promise<void>
  resolve: () => void
} => {
  let resolve!: () => void
  const promise = new Promise<void>((deferredResolve) => {
    resolve = deferredResolve
  })
  return { promise, resolve }
}

const createResponseDeferred = (): {
  promise: Promise<Response>
  resolve: (response: Response) => void
} => {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((deferredResolve) => {
    resolve = deferredResolve
  })
  return { promise, resolve }
}

const createJsonResponsesResponse = (model: string): Response =>
  new Response(JSON.stringify(createResponsesResult(model)), {
    headers: { "content-type": "application/json" },
  })
