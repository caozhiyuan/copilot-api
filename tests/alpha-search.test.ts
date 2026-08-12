import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import type { ResponsesPayload, ResponsesResult } from "~/lib/types/responses"

let codexProviderConfig: ResolvedProviderConfig | null = null
let openrouterProviderConfig: ResolvedProviderConfig | null = null
let alphaSearchCodexPriorityEnabled = true
let modelMappings: Record<string, string> = {}

const { state } = await import("~/lib/state")
const { HTTPError } = await import("~/lib/error")
const { closeUsageStore } = await import("~/lib/token-usage")
const { forwardCodexAlphaSearch, resolveCodexAlphaSearchUrl } = await import(
  "~/services/codex/alpha-search"
)
const { forwardCodexModels, getModels, resolveCodexModelsUrl } = await import(
  "~/services/codex/get-models"
)
const { alphaSearchRouteDependencies, alphaSearchRoutes } = await import(
  "~/routes/alpha-search/route"
)
const { alphaSearchResponsesDependencies, resetAlphaSearchState } =
  await import("~/routes/alpha-search/alpha-search-responses")
const { providerAlphaSearchRouteDependencies, providerAlphaSearchRoutes } =
  await import("~/routes/provider/alpha-search/route")

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

const originalFetch = globalThis.fetch
const originalResponsesDependencies = { ...alphaSearchResponsesDependencies }
const originalRouteDependencies = { ...alphaSearchRouteDependencies }
const originalProviderRouteDependencies = {
  ...providerAlphaSearchRouteDependencies,
}
const originalModels = state.models
const originalCopilotToken = state.copilotToken
const originalMacMachineId = state.macMachineId
const alphaSearchPayload = {
  id: "search-request-id",
  model: "codex/gpt-5.6-sol",
  input: [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "search query",
        },
      ],
      internal_chat_message_metadata_passthrough: {
        turn_id: "turn-id",
      },
    },
    {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "searching",
        },
      ],
      phase: "commentary",
      internal_chat_message_metadata_passthrough: {
        turn_id: "turn-id",
      },
    },
  ],
  commands: {
    open: [{ ref_id: "turn0search0" }],
    response_length: "long",
  },
  settings: {
    allowed_callers: ["direct"],
    external_web_access: false,
  },
  max_output_tokens: 10_000,
}

function createFallbackPayload(
  commands: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "fallback-session",
    model: "gpt-5.6-sol",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Use the search commands." }],
      },
    ],
    commands,
    settings: {
      external_web_access: "live",
    },
    max_output_tokens: 4096,
    ...overrides,
  }
}

function createResponsesResult(
  options: {
    answer?: string
    citations?: boolean
    query?: string
    sources?: Array<{ title?: string; url: string }>
  } = {},
): ResponsesResult {
  const answer = options.answer ?? "Grounded search answer."
  const sources = options.sources ?? [
    { title: "Example", url: "https://example.com/result" },
  ]
  return {
    id: "resp-alpha-search",
    object: "response",
    created_at: 0,
    model: "gpt-5.6-sol",
    output: [
      {
        type: "web_search_call",
        id: "search-call",
        status: "completed",
        action: {
          type: "search",
          query: options.query ?? "search query",
          sources: sources.map(({ url }) => ({ type: "url", url })),
        },
      },
      {
        id: "message-alpha-search",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: answer,
            annotations:
              options.citations === false ?
                []
              : sources.map((source) => ({
                  type: "url_citation",
                  title: source.title,
                  url: source.url,
                  start_index: 0,
                  end_index: answer.length,
                })),
          },
        ],
      },
    ],
    output_text: answer,
    status: "completed",
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "required",
    tools: [],
    top_p: null,
  }
}

const createResponsesMock = mock(
  (_payload: ResponsesPayload, _options: unknown): Promise<ResponsesResult> =>
    Promise.resolve(createResponsesResult()),
)
const fetchMock = mock(
  (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify({ results: [{ title: "result" }] }), {
        headers: {
          "content-type": "application/json",
          "x-upstream": "codex",
        },
        status: 200,
      }),
    ),
)

function createApp() {
  const app = new Hono()
  app.route("/alpha/search", alphaSearchRoutes)
  app.route("/v1/alpha/search", alphaSearchRoutes)
  app.route("/:provider/v1/alpha/search", providerAlphaSearchRoutes)
  return app
}

function requestFallback(
  body: unknown,
  path = "/alpha/search",
): Promise<Response> {
  codexProviderConfig = null
  return Promise.resolve(
    createApp().request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

const resolveTestProviderConfig = (
  provider: string,
): Promise<ResolvedProviderConfig | null> => {
  if (provider === "codex") return Promise.resolve(codexProviderConfig)
  if (provider === "openrouter")
    return Promise.resolve(openrouterProviderConfig)
  return Promise.resolve(null)
}

const resolveTestProviderType = (
  providerConfig: ResolvedProviderConfig,
  model: string,
) => providerConfig.models?.[model]?.type ?? providerConfig.type

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()

  alphaSearchCodexPriorityEnabled = true
  modelMappings = {}
  codexProviderConfig = {
    apiKey: "unused-provider-key",
    authType: "oauth2",
    baseUrl: "https://chatgpt.com/backend-api",
    name: "codex",
    type: "openai-responses",
  }
  openrouterProviderConfig = {
    apiKey: "openrouter-key",
    authType: "authorization",
    baseUrl: "https://openrouter.example",
    name: "openrouter",
    type: "openai-compatible",
  }
  state.codexAccessToken = "codex-access-token"
  state.codexAccountId = "account-123"
  state.copilotToken = "copilot-token"
  state.macMachineId = "machine-id"
  state.models = {
    object: "list",
    data: [
      {
        capabilities: { limits: {} },
        id: "gpt-5.6-sol",
        supported_endpoints: ["/responses"],
      },
      {
        capabilities: { limits: {} },
        id: "gpt-search-mapped",
        supported_endpoints: ["/responses"],
      },
    ],
  } as typeof state.models
  state.verbose = false
  fetchMock.mockClear()
  createResponsesMock.mockClear()
  alphaSearchResponsesDependencies.createResponses =
    createResponsesMock as never
  alphaSearchResponsesDependencies.findEndpointModel = (model) =>
    state.models?.data.find((candidate) => candidate.id === model)
  alphaSearchResponsesDependencies.createUsageRecorder = (() =>
    () => {}) as never
  alphaSearchResponsesDependencies.now = () =>
    Date.parse("2026-08-03T12:00:00.000Z")
  alphaSearchResponsesDependencies.resolveMappedModel = (model) =>
    modelMappings[model] ?? model
  alphaSearchResponsesDependencies.resolveEffectiveProviderType =
    resolveTestProviderType
  alphaSearchResponsesDependencies.resolveProviderConfig =
    resolveTestProviderConfig
  alphaSearchRouteDependencies.findEndpointModel = (model) =>
    state.models?.data.find((candidate) => candidate.id === model)
  alphaSearchRouteDependencies.getAlphaSearchModel = () => "gpt-5-mini"
  alphaSearchRouteDependencies.isAlphaSearchCodexPriorityEnabled = () =>
    alphaSearchCodexPriorityEnabled
  alphaSearchRouteDependencies.resolveEffectiveProviderType =
    resolveTestProviderType
  alphaSearchRouteDependencies.resolveMappedModel = (model) =>
    modelMappings[model] ?? model
  alphaSearchRouteDependencies.resolveProviderConfig = resolveTestProviderConfig
  providerAlphaSearchRouteDependencies.resolveProviderConfig =
    resolveTestProviderConfig
  resetAlphaSearchState()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(async () => {
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.codexAccessToken = undefined
  state.codexAccountId = undefined
  state.copilotToken = originalCopilotToken
  state.macMachineId = originalMacMachineId
  state.models = originalModels
  state.verbose = false
  openrouterProviderConfig = null
  Object.assign(alphaSearchResponsesDependencies, originalResponsesDependencies)
  Object.assign(alphaSearchRouteDependencies, originalRouteDependencies)
  Object.assign(
    providerAlphaSearchRouteDependencies,
    originalProviderRouteDependencies,
  )
  resetAlphaSearchState()
})

describe("Codex alpha search URL", () => {
  test("builds the upstream URL and preserves query parameters", () => {
    expect(
      resolveCodexAlphaSearchUrl("http://localhost/alpha/search?q=bun&page=2"),
    ).toBe("https://chatgpt.com/backend-api/codex/alpha/search?q=bun&page=2")
  })

  test("uses the fixed Codex API base URL", () => {
    expect(resolveCodexAlphaSearchUrl("/alpha/search")).toBe(
      "https://chatgpt.com/backend-api/codex/alpha/search",
    )
  })
})

describe("Codex models forwarding", () => {
  test("uses the fixed Codex models URL and preserves query parameters", () => {
    expect(
      resolveCodexModelsUrl("http://localhost/v1/models?client=codex"),
    ).toBe("https://chatgpt.com/backend-api/codex/models?client=codex")
  })

  test("forwards model requests with Codex auth headers", async () => {
    await forwardCodexModels(
      "http://localhost/v1/models?client=codex",
      new Headers({ accept: "*/*" }),
    )

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://chatgpt.com/backend-api/codex/models?client=codex",
    )
    expect(init?.method).toBe("GET")
    const headers = new Headers(init?.headers)
    expect(headers.get("accept")).toBe("*/*")
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
  })

  test("keeps the built-in Codex model catalog available", () => {
    const models = getModels()
    expect(models.object).toBe("list")
    expect(models.data.map((model) => model.id)).toContain("gpt-5.6-sol")
  })
})

describe("Codex alpha search forwarding", () => {
  test("forwards POST body, query, and Codex auth headers", async () => {
    const response = await createApp().request(
      "/alpha/search?q=typescript&limit=5",
      {
        method: "POST",
        headers: {
          accept: "*/*",
          authorization: "Bearer client-token",
          "content-type": "application/json",
          cookie: "session=test-cookie",
          originator: "codex-tui",
          "user-agent": "codex-tui/test",
          "x-client-header": "kept",
        },
        body: JSON.stringify(alphaSearchPayload),
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("x-upstream")).toBe("codex")
    expect(await response.json()).toEqual({
      results: [{ title: "result" }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://chatgpt.com/backend-api/codex/alpha/search?q=typescript&limit=5",
    )
    expect(init?.method).toBe("POST")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
    expect(headers.get("accept")).toBe("*/*")
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("cookie")).toBe("session=test-cookie")
    expect(headers.get("originator")).toBe("codex-tui")
    expect(headers.get("user-agent")).toBe("codex-tui/test")
    expect(headers.get("x-client-header")).toBe("kept")
    expect(await new Response(init?.body).json()).toEqual({
      ...alphaSearchPayload,
      model: "gpt-5.6-sol",
    })
  })

  test("does not expose alpha search over GET", async () => {
    const response = await createApp().request("/alpha/search?q=bun")

    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("supports the v1 alpha search alias", async () => {
    const response = await createApp().request("/v1/alpha/search?q=bun", {
      method: "POST",
      body: JSON.stringify(alphaSearchPayload),
    })

    expect(response.status).toBe(200)
    const [url] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://chatgpt.com/backend-api/codex/alpha/search?q=bun")
  })

  test("supports the provider-scoped alpha search route", async () => {
    const response = await createApp().request(
      "/codex/v1/alpha/search?q=provider",
      {
        method: "POST",
        body: JSON.stringify(alphaSearchPayload),
      },
    )

    expect(response.status).toBe(200)
    const [url] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://chatgpt.com/backend-api/codex/alpha/search?q=provider",
    )
  })

  test("proxies non-codex providers on the provider-scoped alpha search route", async () => {
    const response = await createApp().request(
      "/openrouter/v1/alpha/search?q=generic",
      {
        method: "POST",
        headers: {
          accept: "*/*",
          "content-type": "application/json",
        },
        body: JSON.stringify(alphaSearchPayload),
      },
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://openrouter.example/v1/alpha/search?q=generic")
    expect(init?.method).toBe("POST")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer openrouter-key")
    expect(headers.get("content-type")).toBe("application/json")
    expect(await new Response(init?.body).json()).toEqual(alphaSearchPayload)
  })

  test("reads request and response bodies when debug logging is enabled", async () => {
    state.verbose = true

    const response = await createApp().request("/alpha/search", {
      method: "POST",
      body: JSON.stringify(alphaSearchPayload),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      results: [{ title: "result" }],
    })
  })

  test("preserves non-JSON upstream responses when debug logging is enabled", async () => {
    state.verbose = true
    const nonJsonFetchMock = mock(
      (): Promise<Response> =>
        Promise.resolve(new Response("upstream failed", { status: 502 })),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      nonJsonFetchMock as unknown as typeof fetch

    const response = await createApp().request("/alpha/search", {
      method: "POST",
      body: JSON.stringify(alphaSearchPayload),
    })

    expect(response.status).toBe(502)
    expect(await response.text()).toBe("upstream failed")
  })

  test("adds JSON content type when a request body has none", async () => {
    await forwardCodexAlphaSearch(
      new Request("http://localhost/alpha/search", {
        method: "POST",
        body: new Uint8Array([123, 125]),
      }),
    )

    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    )
  })

  test("supports srvx-style wrapped requests when rebuilding the Codex request", async () => {
    // srvx's Node adapter wraps incoming requests in a class whose prototype
    // chain satisfies `instanceof Request` without native Request internals.
    const realRequest = new Request("http://localhost/alpha/search?q=srvx", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-header": "kept",
      },
      body: JSON.stringify(alphaSearchPayload),
    })
    class RequestWrapper {
      get url() {
        return realRequest.url
      }
      get method() {
        return realRequest.method
      }
      get headers() {
        return realRequest.headers
      }
      get signal() {
        return realRequest.signal
      }
      clone() {
        return realRequest.clone()
      }
    }
    Object.setPrototypeOf(RequestWrapper.prototype, Request.prototype)
    const wrappedRequest = new RequestWrapper() as unknown as Request
    expect(wrappedRequest instanceof Request).toBe(true)

    const response = await createApp().fetch(wrappedRequest)

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://chatgpt.com/backend-api/codex/alpha/search?q=srvx",
    )
    const headers = new Headers(init?.headers)
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("x-client-header")).toBe("kept")
    expect(await new Response(init?.body).json()).toEqual({
      ...alphaSearchPayload,
      model: "gpt-5.6-sol",
    })
  })

  test("returns 404 when the Codex provider is unavailable", async () => {
    codexProviderConfig = null

    const response = await createApp().request("/alpha/search?q=bun", {
      method: "POST",
      body: JSON.stringify({ model: "codex/gpt-5.6-sol" }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: {
        message: "Provider 'codex' not found or disabled",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("Alpha search Responses adapter", () => {
  test("prefers Codex for unqualified models when Codex priority is enabled", async () => {
    const response = await createApp().request("/alpha/search", {
      method: "POST",
      body: JSON.stringify(
        createFallbackPayload({ search_query: [{ q: "codex first" }] }),
      ),
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(await new Response(init?.body).json()).toMatchObject({
      model: "gpt-5.6-sol",
    })
  })

  test("rewrites non-gpt models to gpt-5.6-luna when prioritizing Codex", async () => {
    const response = await createApp().request("/alpha/search", {
      method: "POST",
      body: JSON.stringify(
        createFallbackPayload(
          { search_query: [{ q: "non-gpt model" }] },
          { model: "claude-opus-4.1" },
        ),
      ),
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(await new Response(init?.body).json()).toMatchObject({
      model: "gpt-5.6-luna",
    })
  })

  test("uses Copilot for unqualified models when Codex is unavailable", async () => {
    codexProviderConfig = null
    const response = await createApp().request("/alpha/search", {
      method: "POST",
      body: JSON.stringify(
        createFallbackPayload({ search_query: [{ q: "copilot wins" }] }),
      ),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
  })

  test("uses Copilot for unqualified models when Codex priority is disabled", async () => {
    alphaSearchCodexPriorityEnabled = false
    const response = await createApp().request("/alpha/search", {
      method: "POST",
      body: JSON.stringify(
        createFallbackPayload({ search_query: [{ q: "copilot wins" }] }),
      ),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
  })

  test("prefers Codex for a provider model when Codex priority is enabled", async () => {
    const response = await createApp().request("/alpha/search", {
      method: "POST",
      body: JSON.stringify(
        createFallbackPayload(
          { search_query: [{ q: "codex priority" }] },
          { model: "openrouter/gpt-5.6-sol" },
        ),
      ),
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(await new Response(init?.body).json()).toMatchObject({
      model: "gpt-5.6-sol",
    })
  })

  test("uses the provider Responses API when Codex priority is disabled", async () => {
    alphaSearchCodexPriorityEnabled = false
    openrouterProviderConfig = {
      ...openrouterProviderConfig!,
      type: "openai-responses",
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify(createResponsesResult()), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
    )

    const response = await createApp().request("/alpha/search", {
      method: "POST",
      body: JSON.stringify(
        createFallbackPayload(
          { search_query: [{ q: "provider search" }] },
          { model: "openrouter/gpt-5.6-sol" },
        ),
      ),
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).not.toHaveBeenCalled()
    expect(((await response.json()) as { output: string }).output).toContain(
      "Grounded search answer.",
    )
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://openrouter.example/v1/responses")
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer openrouter-key",
    )
    expect(await new Response(init?.body).json()).toMatchObject({
      model: "gpt-5.6-sol",
    })
  })

  test("uses the provider Responses API when Codex is unavailable", async () => {
    codexProviderConfig = null
    openrouterProviderConfig = {
      ...openrouterProviderConfig!,
      type: "openai-responses",
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify(createResponsesResult()), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
    )

    const response = await createApp().request("/alpha/search", {
      method: "POST",
      body: JSON.stringify(
        createFallbackPayload(
          { search_query: [{ q: "provider fallback" }] },
          { model: "openrouter/gpt-5.6-sol" },
        ),
      ),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(createResponsesMock).not.toHaveBeenCalled()
  })

  test("supports the v1 alias and translates the complete live request", async () => {
    modelMappings = { "gpt-5.6-sol": "gpt-search-mapped" }
    const response = await requestFallback(
      createFallbackPayload(
        {
          search_query: [
            {
              q: "OpenAI news",
              recency: 7,
              domains: ["openai.com"],
              future_query_field: "kept",
            },
          ],
          finance: [{ ticker: "MSFT", type: "equity", market: "USA" }],
          weather: [
            {
              location: "US, CA, San Francisco",
              start: "2026-08-03",
              duration: 3,
            },
          ],
          sports: [
            {
              tool: "sports",
              fn: "schedule",
              league: "nba",
              team: "GSW",
              date_from: "2026-08-03",
              date_to: "2026-08-10",
              num_games: 2,
              locale: "en-US",
            },
          ],
          response_length: "long",
        },
        {
          reasoning: { effort: "high", summary: "concise" },
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Recent text" }],
              future_input_field: "kept",
            },
          ],
          settings: {
            external_web_access: "live",
            search_context_size: "high",
            filters: {
              allowed_domains: ["openai.com"],
              blocked_domains: ["example.net"],
            },
            user_location: {
              type: "approximate",
              country: "US",
              city: "San Francisco",
            },
          },
          max_output_tokens: 2048,
          future_request_field: "kept",
        },
      ),
      "/v1/alpha/search",
    )

    expect(response.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
    const [payload, options] = createResponsesMock.mock.calls[0] ?? []
    expect(payload?.model).toBe("gpt-search-mapped")
    expect(payload?.tool_choice).toBe("required")
    expect(payload?.store).toBe(false)
    expect(payload?.stream).toBe(false)
    expect(payload?.include).toEqual(["web_search_call.action.sources"])
    expect(payload?.reasoning).toEqual({ effort: "high", summary: "concise" })
    expect(payload?.max_output_tokens).toBe(2048)
    expect(payload?.tools).toEqual([
      {
        type: "web_search",
        filters: {
          allowed_domains: ["openai.com"],
          blocked_domains: ["example.net"],
        },
        user_location: {
          type: "approximate",
          country: "US",
          city: "San Francisco",
        },
        search_context_size: "high",
      },
    ])
    expect(options).toMatchObject({
      initiator: "agent",
      transport: "http",
      vision: false,
    })

    const instruction = payload?.input as string
    expect(instruction).not.toContain("Recent text")
    expect(instruction).toContain('"recency": 7')
    expect(instruction).toContain('"operation": "finance"')
    expect(instruction).toContain('"type": "equity"')
    expect(instruction).toContain('"market": "USA"')
    expect(instruction).toContain('"operation": "weather"')
    expect(instruction).toContain('"operation": "sports"')
    expect(instruction).toContain('"team": "GSW"')
    expect(instruction).toContain("Requested response length: long")

    const body = (await response.json()) as {
      encrypted_output: string | null
      output: string
      results: Array<Record<string, string>>
    }
    expect(body.encrypted_output).toBeNull()
    expect(body.output).toContain("Grounded search answer.")
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toEqual({
      domain: "example.com",
      ref_id: "turn0search0",
      snippet: "Grounded search answer.",
      title: "Example",
      type: "text_result",
      url: "https://example.com/result",
    })
  })

  test("prefers cited sources and falls back to included action sources", async () => {
    const resultWithUncitedSource = createResponsesResult({
      sources: [
        { title: "Cited", url: "https://example.com/cited" },
        { title: "Uncited", url: "https://example.com/uncited" },
      ],
    })
    const message = resultWithUncitedSource.output[1] as {
      content: Array<{ annotations?: Array<unknown> }>
    }
    message.content[0].annotations = message.content[0].annotations?.slice(0, 1)
    createResponsesMock.mockImplementationOnce(() =>
      Promise.resolve(resultWithUncitedSource),
    )
    const citedResponse = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "cited source" }] }),
    )
    const citedBody = (await citedResponse.json()) as {
      results: Array<Record<string, string>>
    }
    expect(citedBody.results.map(({ url }) => url)).toEqual([
      "https://example.com/cited",
    ])

    createResponsesMock.mockImplementationOnce(() =>
      Promise.resolve(
        createResponsesResult({
          citations: false,
          sources: [{ url: "https://example.com/action-source" }],
        }),
      ),
    )
    const fallbackResponse = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "action source" }] }),
    )
    const fallbackBody = (await fallbackResponse.json()) as {
      results: Array<Record<string, string>>
    }

    expect(fallbackBody.results).toEqual([
      {
        type: "text_result",
        domain: "example.com",
        ref_id: "turn1search0",
        snippet: "https://example.com/action-source",
        title: "https://example.com/action-source",
        url: "https://example.com/action-source",
      },
    ])
  })

  test("rejects malformed fallback payloads without parsing native Codex traffic", async () => {
    codexProviderConfig = null
    const invalidJson = await createApp().request("/alpha/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })
    expect(invalidJson.status).toBe(400)

    const missingFields = await requestFallback({ commands: {} })
    expect(missingFields.status).toBe(400)
    const missingFieldsBody = (await missingFields.json()) as {
      error: { message: string }
    }
    expect(missingFieldsBody.error.message).toContain(
      "Invalid alpha search request",
    )

    const invalidOffset = await requestFallback(
      createFallbackPayload({ time: [{ utc_offset: "UTC+3" }] }),
    )
    expect(invalidOffset.status).toBe(400)
    expect(createResponsesMock).not.toHaveBeenCalled()
  })

  test("returns one no-retry warning per unsupported command type", async () => {
    const mixedResponse = await requestFallback(
      createFallbackPayload(
        {
          search_query: [{ q: "supported" }],
          image_query: [{ q: "one" }, { q: "two" }],
          screenshot: [
            { ref_id: "https://example.com/a.pdf", pageno: 0 },
            { ref_id: "https://example.com/a.pdf", pageno: 1 },
          ],
          future_visual_search: [{ q: "future" }],
        },
        {
          input: "Run search_query, image_query, and screenshot.",
        },
      ),
    )
    const mixedBody = (await mixedResponse.json()) as { output: string }

    expect(mixedResponse.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
    expect(mixedBody.output.match(/image_query/gu)).toHaveLength(1)
    expect(mixedBody.output.match(/screenshot/gu)).toHaveLength(1)
    expect(mixedBody.output.match(/future_visual_search/gu)).toHaveLength(1)
    expect(mixedBody.output).toContain("Do not retry")
    const instruction = createResponsesMock.mock.calls[0]?.[0].input as string
    expect(instruction).toContain("complete and exclusive")
    expect(instruction).toContain('"operation": "search_query"')
    expect(instruction).not.toContain('"operation": "image_query"')
    expect(instruction).not.toContain('"operation": "screenshot"')

    const unsupportedOnly = await requestFallback(
      createFallbackPayload(
        {
          image_query: [{ q: "images" }],
          screenshot: [{ ref_id: "turn0view0", pageno: 0 }],
        },
        { id: "unsupported-only" },
      ),
    )
    expect(unsupportedOnly.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
  })

  test("never turns explicit non-live modes into live retrieval", async () => {
    for (const [index, mode] of [false, "cached", "indexed"].entries()) {
      const response = await requestFallback(
        createFallbackPayload(
          { search_query: [{ q: "must not run" }] },
          {
            id: `non-live-${index}`,
            settings: { external_web_access: mode },
          },
        ),
      )
      const body = (await response.json()) as { output: string }
      expect(response.status).toBe(200)
      expect(body.output).toContain("supports live retrieval only")
      expect(body.output).toContain("Do not retry")
    }
    expect(createResponsesMock).not.toHaveBeenCalled()
  })

  test("computes time locally with the injected clock", async () => {
    const response = await requestFallback(
      createFallbackPayload({
        time: [{ utc_offset: "+03:00" }, { utc_offset: "-04:30" }],
      }),
    )
    const body = (await response.json()) as { output: string }

    expect(response.status).toBe(200)
    expect(body.output).toContain("Time at UTC+03:00: 2026-08-03 15:00:00")
    expect(body.output).toContain("Time at UTC-04:30: 2026-08-03 07:30:00")
    expect(createResponsesMock).not.toHaveBeenCalled()
  })

  test("requires a Responses-capable alpha search model for Messages-backed models", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: { limits: {} },
          id: "gpt-5.6-sol",
          supported_endpoints: ["/chat/completions"],
        },
      ],
    } as typeof state.models

    const response = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "unsupported endpoint" }] }),
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain(
      "Configured alphaSearchModel 'gpt-5-mini' does not support the Responses endpoint",
    )
    expect(createResponsesMock).not.toHaveBeenCalled()
  })

  test("redirects Messages-backed alpha search to alphaSearchModel", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: { limits: {} },
          id: "gpt-5.6-sol",
          supported_endpoints: ["/chat/completions"],
        },
        {
          capabilities: { limits: {} },
          id: "gpt-5-mini",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models

    const response = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "redirect search" }] }),
    )

    expect(response.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
    expect(createResponsesMock.mock.calls[0]?.[0].model).toBe("gpt-5-mini")
  })

  test("keeps stable deduplicated search references across turns", async () => {
    createResponsesMock.mockImplementation(() =>
      Promise.resolve(
        createResponsesResult({
          sources: [
            { title: "First title", url: "https://example.com/same" },
            { title: "Duplicate", url: "https://example.com/same" },
          ],
        }),
      ),
    )

    const first = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "first" }] }),
    )
    const second = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "second" }] }),
    )
    const firstBody = (await first.json()) as {
      results: Array<{ ref_id: string }>
    }
    const secondBody = (await second.json()) as {
      results: Array<{ ref_id: string }>
    }

    expect(firstBody.results).toHaveLength(1)
    expect(firstBody.results[0]?.ref_id).toBe("turn0search0")
    expect(secondBody.results[0]?.ref_id).toBe("turn0search0")
  })

  test("opens, line-windows, finds, and clicks through bounded cached views", async () => {
    const results = [
      createResponsesResult({
        answer: "Search answer",
        sources: [{ title: "Page A", url: "https://example.com/a" }],
      }),
      createResponsesResult({
        answer:
          "zero\nneedle line\ntwo\n[Page B](https://example.com/b)\n([Page A](https://example.com/a))",
        sources: [{ title: "Page A", url: "https://example.com/a" }],
      }),
      createResponsesResult({
        answer: "Clicked page text",
        sources: [{ title: "Page C", url: "https://example.com/c" }],
      }),
    ]
    let responseIndex = 0
    createResponsesMock.mockImplementation(() =>
      Promise.resolve(results[responseIndex++] ?? results.at(-1)!),
    )

    const search = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "page a" }] }),
    )
    const searchBody = (await search.json()) as {
      results: Array<{ ref_id: string }>
    }
    expect(searchBody.results[0]?.ref_id).toBe("turn0search0")

    const opened = await requestFallback(
      createFallbackPayload({ open: [{ ref_id: "turn0search0" }] }),
    )
    const openedBody = (await opened.json()) as { output: string }
    expect(openedBody.output).toContain("Open turn1view0")
    expect(openedBody.output).toContain("L1: needle line")
    expect(openedBody.output).toContain(
      "[0] Page B — https://example.com/b (turn1search0)",
    )
    expect(openedBody.output).not.toContain("Page A — https://example.com/a)")

    const windowed = await requestFallback(
      createFallbackPayload({ open: [{ ref_id: "turn1view0", lineno: 1 }] }),
    )
    expect(((await windowed.json()) as { output: string }).output).toContain(
      "L1: needle line",
    )

    const found = await requestFallback(
      createFallbackPayload({
        find: [{ ref_id: "turn1view0", pattern: "needle" }],
      }),
    )
    expect(((await found.json()) as { output: string }).output).toContain(
      'Find results for "needle" in turn1view0',
    )

    const clicked = await requestFallback(
      createFallbackPayload({ click: [{ ref_id: "turn1view0", id: 0 }] }),
    )
    expect(((await clicked.json()) as { output: string }).output).toContain(
      "Clicked page text",
    )
    expect(createResponsesMock).toHaveBeenCalledTimes(3)

    const cachedClick = await requestFallback(
      createFallbackPayload({ click: [{ ref_id: "turn1view0", id: 0 }] }),
    )
    expect(((await cachedClick.json()) as { output: string }).output).toContain(
      "Clicked page text",
    )
    expect(createResponsesMock).toHaveBeenCalledTimes(3)
  })

  test("uses Copilot find only when opened text cannot satisfy it locally", async () => {
    const results = [
      createResponsesResult({
        answer: "Search answer",
        sources: [{ title: "Find page", url: "https://example.com/find" }],
      }),
      createResponsesResult({
        answer: "Remote matching context",
        sources: [{ title: "Find page", url: "https://example.com/find" }],
      }),
    ]
    let responseIndex = 0
    createResponsesMock.mockImplementation(() =>
      Promise.resolve(results[responseIndex++] ?? results.at(-1)!),
    )

    await requestFallback(
      createFallbackPayload({ search_query: [{ q: "find page" }] }),
    )
    const found = await requestFallback(
      createFallbackPayload({
        find: [{ ref_id: "turn0search0", pattern: "remote" }],
      }),
    )
    expect(((await found.json()) as { output: string }).output).toContain(
      "Remote matching context",
    )
    const payload = createResponsesMock.mock.calls[1]?.[0]
    const instruction = payload?.input as string
    expect(instruction).toContain('"operation": "find"')

    const cached = await requestFallback(
      createFallbackPayload({ open: [{ ref_id: "turn0search0" }] }),
    )
    expect(((await cached.json()) as { output: string }).output).toContain(
      "Remote matching context",
    )
    expect(createResponsesMock).toHaveBeenCalledTimes(2)
  })

  test("isolates, expires, and evicts session references", async () => {
    const search = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "session reference" }] }),
    )
    expect(search.status).toBe(200)

    const crossSession = await requestFallback(
      createFallbackPayload(
        { open: [{ ref_id: "turn0search0" }] },
        { id: "different-session" },
      ),
    )
    expect(
      ((await crossSession.json()) as { output: string }).output,
    ).toContain("unavailable or expired")
    expect(createResponsesMock).toHaveBeenCalledTimes(1)

    alphaSearchResponsesDependencies.now = () =>
      Date.parse("2026-08-03T13:00:00.000Z")
    const expired = await requestFallback(
      createFallbackPayload({ open: [{ ref_id: "turn0search0" }] }),
    )
    expect(((await expired.json()) as { output: string }).output).toContain(
      "unavailable or expired",
    )

    alphaSearchResponsesDependencies.now = () =>
      Date.parse("2026-08-03T14:00:00.000Z")
    await requestFallback(
      createFallbackPayload(
        { search_query: [{ q: "oldest" }] },
        { id: "oldest-session" },
      ),
    )
    for (let index = 0; index < 128; index += 1) {
      await requestFallback(
        createFallbackPayload(
          { time: [{ utc_offset: "+00:00" }] },
          { id: `new-session-${index}` },
        ),
      )
    }
    const evicted = await requestFallback(
      createFallbackPayload(
        { open: [{ ref_id: "turn0search0" }] },
        { id: "oldest-session" },
      ),
    )
    expect(((await evicted.json()) as { output: string }).output).toContain(
      "unavailable or expired",
    )
  })

  test("enforces URL-reference and opened-snapshot ceilings", async () => {
    const manySources = Array.from({ length: 257 }, (_, index) => ({
      title: `Source ${index}`,
      url: `https://example.com/source-${index}`,
    }))
    createResponsesMock.mockImplementation(() =>
      Promise.resolve(createResponsesResult({ sources: manySources })),
    )
    const manySourceResponse = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "many sources" }] }),
    )
    expect(
      ((await manySourceResponse.json()) as { results: Array<unknown> })
        .results,
    ).toHaveLength(256)
    const evictedReference = await requestFallback(
      createFallbackPayload({ open: [{ ref_id: "turn0search0" }] }),
    )
    expect(
      ((await evictedReference.json()) as { output: string }).output,
    ).toContain("unavailable or expired")

    resetAlphaSearchState()
    createResponsesMock.mockImplementation(() =>
      Promise.resolve(
        createResponsesResult({
          answer: "Opened text",
          sources: [],
        }),
      ),
    )
    for (let index = 0; index < 17; index += 1) {
      await requestFallback(
        createFallbackPayload({
          open: [{ ref_id: `https://example.com/page-${index}` }],
        }),
      )
    }
    const evictedSnapshot = await requestFallback(
      createFallbackPayload({ open: [{ ref_id: "turn0view0" }] }),
    )
    expect(
      ((await evictedSnapshot.json()) as { output: string }).output,
    ).toContain("unavailable or expired")
  })

  test("surfaces missing Copilot auth and upstream rate-limit headers", async () => {
    createResponsesMock.mockImplementationOnce(() =>
      Promise.reject(new Error("Copilot token not found")),
    )
    const missingAuth = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "auth" }] }),
    )
    expect(missingAuth.status).toBe(500)
    const missingAuthBody = (await missingAuth.json()) as {
      error: { message: string }
    }
    expect(missingAuthBody.error.message).toContain("Copilot token not found")

    alphaSearchResponsesDependencies.createResponses = (() =>
      Promise.reject(
        new HTTPError(
          "rate limited",
          new Response('{"error":"rate limited"}', {
            status: 429,
            headers: {
              "retry-after": "12",
              "x-ratelimit-remaining": "0",
            },
          }),
        ),
      )) as never
    const rateLimited = await requestFallback(
      createFallbackPayload(
        { search_query: [{ q: "rate limit" }] },
        { id: "rate-limited-session" },
      ),
    )
    expect(rateLimited.status).toBe(429)
    expect(rateLimited.headers.get("retry-after")).toBe("12")
    expect(rateLimited.headers.get("x-ratelimit-remaining")).toBe("0")
  })
})
