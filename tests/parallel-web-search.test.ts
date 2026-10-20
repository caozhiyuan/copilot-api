import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  getMessageApiWebSearchModel,
  invalidateConfigCache,
  reloadConfig,
  writeConfigToDisk,
  type AppConfig,
} from "~/lib/config"
import { PATHS } from "~/lib/paths"
import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import { messageRoutes } from "~/routes/messages/route"
import {
  resolveWebSearchRoute,
  tryHandleWebSearch,
  webSearchFlowDependencies,
} from "~/routes/messages/web-search/fulfill"
import { parallelSearchDependencies } from "~/services/parallel/search"

const originalPaths = { ...PATHS }
const originalDependencies = { ...parallelSearchDependencies }
const originalResolver = webSearchFlowDependencies.resolveProviderConfig
let directory: string
type Rpc = {
  id?: number
  method: string
  params?: { arguments?: Record<string, unknown> }
}
const requests: Array<{ url: string; headers: Headers; rpc?: Rpc }> = []
let toolResult: Record<string, unknown>
let toolsAvailable: boolean
let waitForAbort: boolean
let observedSignal: AbortSignal | null | undefined

const payload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  model: "claude-sonnet-4.5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Node.js latest release" }],
  tools: [
    {
      type: "web_search_20250305",
      name: "web_search",
      input_schema: undefined as never,
    },
  ],
  ...overrides,
})

function saveConfig(config: AppConfig = {}) {
  writeConfigToDisk(config)
  reloadConfig()
}

const app = new Hono().route("/v1/messages", messageRoutes)
const request = (body = payload(), session?: string, signal?: AbortSignal) =>
  app.request("/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session ? { "x-root-session-id": session } : {}),
    },
    body: JSON.stringify(body),
    signal,
  })

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-parallel-test-"))
  PATHS.APP_DIR = directory
  PATHS.CONFIG_PATH = path.join(directory, "config.json")
  saveConfig()
  requests.length = 0
  toolsAvailable = true
  waitForAbort = false
  observedSignal = undefined
  toolResult = {
    structuredContent: {
      results: [
        {
          url: "https://nodejs.org/en/blog",
          title: "Node.js Releases",
          excerpts: ["Current release details."],
        },
      ],
    },
    content: [],
  }
  parallelSearchDependencies.fetch = async (url, init) => {
    const rpc: Rpc | undefined =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Rpc)
      : undefined
    requests.push({
      url: url instanceof Request ? url.url : url.toString(),
      headers: new Headers(init?.headers),
      rpc,
    })
    if (init?.method === "GET") return new Response(null, { status: 405 })
    if (rpc?.id === undefined) return new Response(null, { status: 202 })
    let result: object
    if (rpc.method === "initialize") {
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      }
    } else if (rpc.method === "tools/list") {
      result = {
        tools:
          toolsAvailable ?
            [{ name: "web_search", inputSchema: { type: "object" } }]
          : [],
      }
    } else if (waitForAbort) {
      observedSignal = init?.signal
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("Request aborted")),
          { once: true },
        )
      })
    } else {
      result = toolResult
    }
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result })
  }
})

afterEach(() => {
  Object.assign(PATHS, originalPaths)
  Object.assign(parallelSearchDependencies, originalDependencies)
  webSearchFlowDependencies.resolveProviderConfig = originalResolver
  invalidateConfigCache()
  fs.rmSync(directory, { recursive: true, force: true })
})

const calls = () =>
  requests
    .filter(({ rpc }) => rpc?.method === "tools/call")
    .map(({ rpc }) => rpc?.params?.arguments ?? {})

describe("Parallel through the Messages dispatcher", () => {
  test("fresh no-key config resolves and consumes anonymous MCP results", async () => {
    fs.unlinkSync(PATHS.CONFIG_PATH)
    invalidateConfigCache()
    expect(getMessageApiWebSearchModel()).toBe("parallel")
    const response = await request()
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"type":"web_search_tool_result"')
    expect(text).toContain("https://nodejs.org/en/blog")
    expect(text).toContain("Current release details.")
    expect(text).toContain('"web_search_requests":1')
    expect(calls()[0].objective).toBe("Node.js latest release")
    expect(requests.some(({ rpc }) => rpc?.method === "tools/list")).toBe(true)
    for (const observed of requests) {
      expect(observed.url).toBe("https://search.parallel.ai/mcp")
      expect(observed.headers.get("User-Agent")).toContain("copilot-api")
      expect(observed.headers.get("Authorization")).toBeNull()
    }
  })

  test("saved choices, explicit override and disabled search remain selectable", async () => {
    saveConfig({ messageApiWebSearchModel: "gpt-6-luna" })
    expect(getMessageApiWebSearchModel()).toBe("gpt-6-luna")
    expect(
      await resolveWebSearchRoute(payload(), {
        webSearchModel: getMessageApiWebSearchModel(),
        responsesWebSearchEnabled: true,
      }),
    ).toEqual({ kind: "responses", model: "gpt-6-luna" })
    saveConfig({ messageApiWebSearchModel: "" })
    expect(getMessageApiWebSearchModel()).toBeUndefined()
    saveConfig({
      messageApiWebSearchModel: "parallel",
      useResponsesApiWebSearch: false,
    })
    expect(
      await resolveWebSearchRoute(payload(), {
        webSearchModel: getMessageApiWebSearchModel(),
        responsesWebSearchEnabled: false,
      }),
    ).toEqual({ kind: "strip" })
    expect(requests).toHaveLength(0)
  })

  test("provider aliases preserve credentials and forward without MCP", async () => {
    saveConfig({
      messageApiWebSearchModel: "native/search",
      providers: {
        native: {
          type: "anthropic",
          apiKey: "saved-key",
          baseUrl: "https://example.com",
        },
      },
    })
    // Isolate the provider resolver: neighboring tests mock the config barrel.
    // The production Parallel path above still uses the real config and caller.
    webSearchFlowDependencies.resolveProviderConfig = (name) =>
      Promise.resolve(
        name === "native" ?
          {
            name: "native",
            type: "anthropic",
            baseUrl: "https://example.com",
            apiKey: "saved-key",
            authType: "x-api-key",
          }
        : null,
      )
    const bridge = new Hono().post(
      "/",
      async (c) =>
        (await tryHandleWebSearch(c, payload(), {
          logger: consola,
          forwardToProvider: (ctx, body, provider) =>
            Promise.resolve(ctx.json({ model: body.model, provider })),
        })) ?? c.text("continued"),
    )
    expect(
      await (await bridge.request("/", { method: "POST" })).json(),
    ).toEqual({ model: "search", provider: "native" })
    expect(requests).toHaveLength(0)
  })

  test.each([
    payload({ tool_choice: { type: "none" } }),
    payload({ tool_choice: { type: "tool", name: "other" } }),
    payload({ tools: [{ ...payload().tools![0], max_uses: 0 }] }),
    payload({
      tools: [...payload().tools!, { name: "other", input_schema: {} }],
    }),
  ])(
    "does not run search when tools or permission disable it",
    async (body) => {
      expect(
        await resolveWebSearchRoute(body, {
          webSearchModel: "parallel",
          responsesWebSearchEnabled: true,
        }),
      ).toEqual({ kind: "strip" })
      expect(requests).toHaveLength(0)
    },
  )

  test("streams complete source blocks and excerpt text", async () => {
    const response = await request(payload({ stream: true }))
    const body = await response.text()
    expect(response.headers.get("Content-Type")).toContain("text/event-stream")
    expect(body).toContain("event: message_start")
    expect(body).toContain("https://nodejs.org/en/blog")
    expect(body).toContain("Current release details.")
    expect(body).toContain("event: message_stop")
  })

  test("filters domains at result consumption, rejecting non-HTTP URLs", async () => {
    toolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [
              { url: "https://docs.nodejs.org/a", excerpts: ["allowed"] },
              { url: "https://bad.nodejs.org/a", excerpts: ["blocked"] },
              { url: "https://evilnodejs.org/a", excerpts: ["outside"] },
              { url: "javascript:alert(1)", excerpts: ["unsafe"] },
            ],
          }),
        },
      ],
    }
    const response = await request(
      payload({
        tools: [
          {
            ...payload().tools![0],
            allowed_domains: ["nodejs.org"],
            blocked_domains: ["bad.nodejs.org"],
          },
        ],
      }),
    )
    const body = await response.text()
    expect(body).toContain("https://docs.nodejs.org/a")
    expect(body).not.toContain("https://bad.nodejs.org/a")
    expect(body).not.toContain("https://evilnodejs.org/a")
    expect(body).not.toContain("javascript:")
    expect(calls()[0].search_queries).toEqual([
      "Node.js latest release (site:nodejs.org) -site:bad.nodejs.org",
    ])
  })

  test("empty results remain a successful search with no fabricated sources", async () => {
    toolResult = { content: [], structuredContent: { results: [] } }
    expect(await (await request()).text()).toContain(
      "No web search results found.",
    )
  })

  test.each([
    payload({ messages: [{ role: "user", content: [] }] }),
    payload({
      tools: [{ ...payload().tools![0], user_location: { city: "Paris" } }],
    }),
  ])("rejects unsupported input before an external request", async (body) => {
    expect((await request(body)).status).toBe(400)
    expect(requests).toHaveLength(0)
  })

  test("text blocks supply the latest user query", async () => {
    await request(
      payload({
        messages: [
          { role: "user", content: "old query" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: [{ type: "text", text: "latest query" }] },
        ],
      }),
    )
    expect(calls()[0].objective).toBe("latest query")
  })

  test.each([
    { isError: true, content: [{ type: "text", text: "quota reached" }] },
    { content: [{ type: "text", text: "invalid JSON" }] },
    {
      content: [],
      structuredContent: { results: [{ url: "bad", excerpts: [] }] },
    },
  ])(
    "reports service and malformed result errors without fallback",
    async (result) => {
      toolResult = result
      expect((await request()).status).toBe(502)
      expect(calls()).toHaveLength(1)
    },
  )

  test("missing tool is an explicit failure", async () => {
    toolsAvailable = false
    expect((await request()).status).toBe(502)
    expect(calls()).toHaveLength(0)
  })

  test("timeout aborts the actual MCP request", async () => {
    waitForAbort = true
    parallelSearchDependencies.timeoutMs = 20
    expect((await request()).status).toBe(502)
    expect(observedSignal?.aborted).toBe(true)
  })

  test("client cancellation aborts the actual MCP request", async () => {
    waitForAbort = true
    const controller = new AbortController()
    const pending = request(payload(), undefined, controller.signal)
    while (!observedSignal)
      await new Promise((resolve) => setTimeout(resolve, 1))
    controller.abort()
    await pending
    expect(observedSignal.aborted).toBe(true)
  })

  test("interleaved conversations and follow-ups keep isolated opaque IDs", async () => {
    await Promise.all([
      request(payload(), "conversation-a"),
      request(payload(), "conversation-b"),
    ])
    await request(payload(), "conversation-a")
    await request(payload(), "conversation-b")
    await request(payload(), "reset-new-conversation")
    const ids = calls().map((call) => call.session_id)
    expect(ids[0]).toBe(ids[2])
    expect(ids[1]).toBe(ids[3])
    expect(ids[0]).not.toBe(ids[1])
    expect(ids[4]).not.toBe(ids[0])
    expect(ids[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(ids)).not.toContain("conversation")
  })

  test("retry after quota preserves conversation identity", async () => {
    toolResult = { isError: true, content: [{ type: "text", text: "quota" }] }
    await request(payload(), "same-conversation")
    await request(payload(), "same-conversation")
    expect(calls()[0].session_id).toBe(calls()[1].session_id)
  })
})
