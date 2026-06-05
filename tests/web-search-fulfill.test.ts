import { afterEach, describe, expect, it } from "bun:test"
import consola from "consola"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"

import {
  buildSyntheticStreamEvents,
  handleWithMessagesApiWebSearch,
  hasWebSearchServerTool,
  stripWebSearchServerTool,
  webSearchFlowDependencies,
} from "~/routes/messages/web-search/fulfill"

const webSearchTool = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 3,
}

const makePayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload =>
  ({
    model: "claude-sonnet-4.5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "What is new in Node.js?" }],
    tools: [webSearchTool],
    ...overrides,
  }) as unknown as AnthropicMessagesPayload

// Minimal Context stub capturing json() and streamSSE writes.
const makeContext = () => {
  const captured: {
    json?: unknown
    sse: Array<{ event?: string; data: string }>
  } = {
    sse: [],
  }
  const c = {
    json: (value: unknown) => {
      captured.json = value
      return { __json: value }
    },
    header: () => undefined,
    req: { raw: { signal: undefined } },
    newResponse: (body: unknown) => body,
    // hono streamSSE uses these; provide enough surface
    res: {},
    finalized: false,
  }
  return { c: c as never, captured }
}

const originalDeps = { ...webSearchFlowDependencies }

afterEach(() => {
  webSearchFlowDependencies.createMessages = originalDeps.createMessages
  webSearchFlowDependencies.runWebSearch = originalDeps.runWebSearch
  webSearchFlowDependencies.createUsageRecorder =
    originalDeps.createUsageRecorder
})

const baseOptions = {
  logger: consola,
  requestId: "req-1",
  sessionId: "sess-1",
}

describe("web search tool detection", () => {
  it("detects the web_search server tool", () => {
    expect(hasWebSearchServerTool(makePayload())).toBe(true)
  })

  it("ignores normal function tools", () => {
    const payload = makePayload({
      tools: [{ name: "get_weather", input_schema: { type: "object" } }],
    })
    expect(hasWebSearchServerTool(payload)).toBe(false)
  })

  it("strips only the web_search server tool", () => {
    const payload = makePayload({
      tools: [
        webSearchTool,
        { name: "get_weather", input_schema: { type: "object" } },
      ] as never,
    })
    stripWebSearchServerTool(payload)
    expect(payload.tools).toHaveLength(1)
    expect(payload.tools?.[0].name).toBe("get_weather")
  })
})

const assistantText = (text: string): AnthropicResponse => ({
  id: "msg_final",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text }],
  model: "claude-sonnet-4.5",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 20 },
})

const assistantSearch = (query: string): AnthropicResponse => ({
  id: "msg_search",
  type: "message",
  role: "assistant",
  content: [
    { type: "tool_use", id: "toolu_1", name: "web_search", input: { query } },
  ],
  model: "claude-sonnet-4.5",
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 8 },
})

describe("handleWithMessagesApiWebSearch", () => {
  it("fulfills a search and reconstructs native web search blocks", async () => {
    const calls: Array<AnthropicMessagesPayload> = []
    let turn = 0
    webSearchFlowDependencies.createMessages = ((
      payload: AnthropicMessagesPayload,
    ) => {
      calls.push(payload)
      turn += 1
      // First turn: Claude asks to search. Second: final answer.
      return Promise.resolve(
        turn === 1 ?
          assistantSearch("node lts version")
        : assistantText("Node.js 24 is the latest LTS."),
      )
    }) as never
    const searchArgs: Array<string> = []
    webSearchFlowDependencies.runWebSearch = ((query: string) => {
      searchArgs.push(query)
      return Promise.resolve({
        answerText: "Node 24 is LTS.",
        sources: [{ url: "https://nodejs.org", title: "Node.js" }],
        queriesRun: [query],
      })
    }) as never
    webSearchFlowDependencies.createUsageRecorder = (() => () => {}) as never

    const { c, captured } = makeContext()
    await handleWithMessagesApiWebSearch(c, makePayload(), baseOptions)

    // Backend received the query Claude requested.
    expect(searchArgs).toEqual(["node lts version"])
    // Two Claude calls: search request + final answer.
    expect(calls).toHaveLength(2)
    // The injected function tool replaced the server tool for the loop.
    const loopTool = calls[0].tools?.find((t) => t.name === "web_search")
    expect(loopTool?.input_schema).toBeDefined()
    expect(loopTool?.type).toBeUndefined()

    const response = captured.json as AnthropicResponse
    const types = response.content.map((b) => b.type as string)
    expect(types).toEqual(["server_tool_use", "web_search_tool_result", "text"])
    const serverToolUse = response.content[0] as unknown as {
      input: { query: string }
      name: string
    }
    expect(serverToolUse.name).toBe("web_search")
    expect(serverToolUse.input.query).toBe("node lts version")
    const result = response.content[1] as unknown as {
      content: Array<{ url: string; title: string }>
    }
    expect(result.content[0].url).toBe("https://nodejs.org")
    expect(
      (response.usage as { server_tool_use?: unknown }).server_tool_use,
    ).toEqual({ web_search_requests: 1 })
    // Usage accumulated across both Claude calls.
    expect(response.usage.input_tokens).toBe(15)
    expect(response.usage.output_tokens).toBe(28)
  })

  it("passes through when Claude never searches", async () => {
    let turn = 0
    webSearchFlowDependencies.createMessages = (() => {
      turn += 1
      return Promise.resolve(assistantText("No search needed."))
    }) as never
    let searched = false
    webSearchFlowDependencies.runWebSearch = (() => {
      searched = true
      return Promise.resolve({ answerText: "", sources: [], queriesRun: [] })
    }) as never
    webSearchFlowDependencies.createUsageRecorder = (() => () => {}) as never

    const { c, captured } = makeContext()
    await handleWithMessagesApiWebSearch(c, makePayload(), baseOptions)

    expect(turn).toBe(1)
    expect(searched).toBe(false)
    const response = captured.json as AnthropicResponse
    expect(response.content.map((b) => b.type)).toEqual(["text"])
  })

  it("surfaces a graceful error block when the backend fails", async () => {
    let turn = 0
    webSearchFlowDependencies.createMessages = (() => {
      turn += 1
      return Promise.resolve(
        turn === 1 ?
          assistantSearch("query")
        : assistantText("Sorry, no live data."),
      )
    }) as never
    webSearchFlowDependencies.runWebSearch = (() =>
      Promise.resolve({
        answerText: "",
        sources: [],
        queriesRun: [],
        error: "boom",
      })) as never
    webSearchFlowDependencies.createUsageRecorder = (() => () => {}) as never

    const { c, captured } = makeContext()
    await handleWithMessagesApiWebSearch(c, makePayload(), baseOptions)

    const response = captured.json as AnthropicResponse
    const resultBlock = response.content[1] as unknown as {
      type: string
      content: { type: string; error_code: string }
    }
    expect(resultBlock.type).toBe("web_search_tool_result")
    expect(resultBlock.content.type).toBe("web_search_tool_result_error")
  })
})

describe("buildSyntheticStreamEvents", () => {
  it("emits a well-formed Anthropic event sequence", () => {
    const response = {
      id: "msg_1",
      type: "message" as const,
      role: "assistant" as const,
      model: "claude-sonnet-4.5",
      stop_reason: "end_turn" as const,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
      content: [
        {
          type: "server_tool_use" as const,
          id: "toolu_1",
          name: "web_search" as const,
          input: { query: "q" },
        },
        {
          type: "web_search_tool_result" as const,
          tool_use_id: "toolu_1",
          content: [
            {
              type: "web_search_result" as const,
              url: "https://x",
              title: "X",
            },
          ],
        },
        { type: "text" as const, text: "answer" },
      ],
    }

    const events = buildSyntheticStreamEvents(response)
    const types = events.map((e) => e.type)

    expect(types[0]).toBe("message_start")
    expect(types.at(-1)).toBe("message_stop")
    expect(types.at(-2)).toBe("message_delta")
    // server_tool_use: start, delta(input_json), stop
    expect(types.slice(1, 4)).toEqual([
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ])
    // web_search_tool_result: start (full block), stop
    expect(types.slice(4, 6)).toEqual([
      "content_block_start",
      "content_block_stop",
    ])
    // text: start, delta, stop
    expect(types.slice(6, 9)).toEqual([
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ])
  })
})
