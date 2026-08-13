import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import { state } from "~/lib/state"
import type { ResponsesResult } from "~/lib/types/responses"

let providerConfig: ResolvedProviderConfig | null = null

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

beforeEach(() => {
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

afterEach(() => {
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

  test("propagates provider-scoped client cancellation upstream without a 500", async () => {
    let upstreamSignal: AbortSignal | undefined
    const upstreamStarted = createDeferred()
    fetchMock.mockImplementation((_url, init) => {
      const signal = init?.signal
      if (!(signal instanceof AbortSignal)) {
        throw new Error("Expected upstream abort signal")
      }
      upstreamSignal = signal
      upstreamStarted.resolve()
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) {
          reject(
            signal.reason instanceof Error ?
              signal.reason
            : new Error("Provider request aborted"),
          )
          return
        }
        signal.addEventListener(
          "abort",
          () =>
            reject(
              signal.reason instanceof Error ?
                signal.reason
              : new Error("Provider request aborted"),
            ),
          { once: true },
        )
      })
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

    const response = await responsePromise
    expect(upstreamSignal?.aborted).toBe(true)
    expect(response.status).toBe(499)
  })

  test("propagates provider-prefixed Codex cancellation upstream", async () => {
    const originalCodexAccessToken = state.codexAccessToken
    const originalCodexAccountId = state.codexAccountId
    let upstreamSignal: AbortSignal | undefined
    const upstreamStarted = createDeferred()
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
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              signal.reason instanceof Error ?
                signal.reason
              : new Error("Codex request aborted"),
            ),
          { once: true },
        )
      })
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

      const response = await responsePromise
      expect(upstreamSignal?.aborted).toBe(true)
      expect(response.status).toBe(499)
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
      models: { "chat-test": {} },
      name: "openai",
      type: "openai-compatible",
    }
    fetchMock.mockImplementation((_url, init) => {
      const body = parseJsonRequestBody(init?.body) as {
        model: string
        tools: Array<{
          type: string
          function: { name: string }
        }>
      }
      expect(body.model).toBe("chat-test")
      expect(body.tools.map((tool) => tool.function.name)).toEqual([
        "apply_patch",
        "workspace__read_file",
      ])
      return Promise.resolve(
        Response.json({
          id: "chatcmpl-lite",
          object: "chat.completion",
          created: 1,
          model: "chat-test",
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
        model: "openai/chat-test",
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
    expect(body.model).toBe("openai/chat-test")
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

  test("adapts Responses Lite directly to an Anthropic Messages provider", async () => {
    providerConfig = {
      apiKey: "provider-key",
      authType: "x-api-key",
      baseUrl: "https://anthropic.example",
      models: { "claude-test": {} },
      name: "anthropic",
      type: "anthropic",
    }
    fetchMock.mockImplementation((_url, init) => {
      const body = parseJsonRequestBody(init?.body) as {
        model: string
        tools: Array<{ name: string }>
      }
      expect(body.model).toBe("claude-test")
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
          model: "claude-test",
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
        model: "anthropic/claude-test",
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
    expect(body.model).toBe("anthropic/claude-test")
    expect(body.output[0]).toMatchObject({
      type: "custom_tool_call",
      call_id: "call-patch",
      name: "apply_patch",
      input: "*** Begin Patch",
    })
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
