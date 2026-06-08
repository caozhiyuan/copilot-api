import { afterEach, describe, expect, it } from "bun:test"
import consola from "consola"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type {
  ResponsesPayload,
  ResponsesResult,
} from "~/services/copilot/create-responses"

import {
  buildSyntheticStreamEvents,
  handleWebSearchViaResponses,
  hasWebSearchServerTool,
  isWebSearchOnlyRequest,
  resolveWebSearchRoute,
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

const makeContext = () => {
  const captured: { json?: unknown } = {}
  const c = {
    json: (value: unknown) => {
      captured.json = value
      return { __json: value }
    },
  }
  return { c: c as never, captured }
}

const makeResponsesResult = (
  overrides: Partial<ResponsesResult> = {},
): ResponsesResult =>
  ({
    id: "resp_1",
    object: "response",
    created_at: 0,
    model: "gpt-5-mini",
    output: [
      { type: "web_search_call", action: { query: "node lts version" } },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Node.js 24 is the latest LTS.",
            annotations: [
              {
                type: "url_citation",
                url: "https://nodejs.org",
                title: "Node.js",
              },
            ],
          },
        ],
      },
    ],
    output_text: "",
    status: "completed",
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: null,
    tools: [],
    top_p: null,
    ...overrides,
  }) as unknown as ResponsesResult

const originalDeps = { ...webSearchFlowDependencies }

afterEach(() => {
  webSearchFlowDependencies.createResponses = originalDeps.createResponses
  webSearchFlowDependencies.createUsageRecorder =
    originalDeps.createUsageRecorder
})

const baseOptions = {
  logger: consola,
  webSearchModel: "gpt-5-mini",
  requestId: "req-1",
  sessionId: "sess-1",
}

describe("web search tool detection", () => {
  it("detects the web_search server tool", () => {
    expect(hasWebSearchServerTool(makePayload())).toBe(true)
  })

  it("treats a web_search-only request as switchable", () => {
    expect(isWebSearchOnlyRequest(makePayload())).toBe(true)
  })

  it("does not switch when web_search is mixed with other tools", () => {
    const payload = makePayload({
      tools: [
        webSearchTool,
        { name: "get_weather", input_schema: { type: "object" } },
      ] as never,
    })
    expect(hasWebSearchServerTool(payload)).toBe(true)
    expect(isWebSearchOnlyRequest(payload)).toBe(false)
  })

  it("ignores normal function tools", () => {
    const payload = makePayload({
      tools: [{ name: "get_weather", input_schema: { type: "object" } }],
    })
    expect(hasWebSearchServerTool(payload)).toBe(false)
    expect(isWebSearchOnlyRequest(payload)).toBe(false)
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

describe("resolveWebSearchRoute", () => {
  const opts = { webSearchModel: "gpt-5-mini", responsesWebSearchEnabled: true }

  it("routes a Copilot model to the responses path", () => {
    expect(resolveWebSearchRoute(makePayload(), opts)).toEqual({
      kind: "responses",
      model: "gpt-5-mini",
    })
  })

  it("routes a provider/model alias to provider passthrough", () => {
    const route = resolveWebSearchRoute(makePayload(), {
      ...opts,
      webSearchModel: "anthropic/claude-sonnet-4-5",
    })
    expect(route).toEqual({
      kind: "provider",
      alias: { provider: "anthropic", model: "claude-sonnet-4-5" },
    })
  })

  it("strips when web_search is mixed with other tools", () => {
    const payload = makePayload({
      tools: [
        webSearchTool,
        { name: "get_weather", input_schema: { type: "object" } },
      ] as never,
    })
    expect(resolveWebSearchRoute(payload, opts).kind).toBe("strip")
  })

  it("strips when no web search model is configured", () => {
    expect(
      resolveWebSearchRoute(makePayload(), {
        webSearchModel: undefined,
        responsesWebSearchEnabled: true,
      }).kind,
    ).toBe("strip")
  })

  it("strips a Copilot model when responses web search is disabled", () => {
    expect(
      resolveWebSearchRoute(makePayload(), {
        webSearchModel: "gpt-5-mini",
        responsesWebSearchEnabled: false,
      }).kind,
    ).toBe("strip")
  })
})

describe("handleWebSearchViaResponses", () => {
  it("switches model, runs Responses web_search, and reconstructs blocks", async () => {
    let sentPayload: ResponsesPayload | undefined
    webSearchFlowDependencies.createResponses = ((
      payload: ResponsesPayload,
    ) => {
      sentPayload = payload
      return Promise.resolve(makeResponsesResult())
    }) as never
    webSearchFlowDependencies.createUsageRecorder = (() => () => {}) as never

    const { c, captured } = makeContext()
    await handleWebSearchViaResponses(c, makePayload(), baseOptions)

    // Request was switched to the GPT model with a Responses web_search tool.
    expect(sentPayload?.model).toBe("gpt-5-mini")
    expect(sentPayload?.tools).toEqual([{ type: "web_search" }])

    const response = captured.json as AnthropicResponse
    const types = response.content.map((b) => b.type as string)
    expect(types).toEqual(["server_tool_use", "web_search_tool_result", "text"])

    const serverToolUse = response.content[0] as unknown as {
      name: string
      input: { query: string }
    }
    expect(serverToolUse.name).toBe("web_search")
    expect(serverToolUse.input.query).toBe("node lts version")

    const result = response.content[1] as unknown as {
      content: Array<{ url: string; title: string }>
    }
    expect(result.content[0].url).toBe("https://nodejs.org")

    const text = response.content[2] as unknown as { text: string }
    expect(text.text).toBe("Node.js 24 is the latest LTS.")

    // Response keeps the original Claude model id.
    expect(response.model).toBe("claude-sonnet-4.5")
    expect(
      (response.usage as { server_tool_use?: unknown }).server_tool_use,
    ).toEqual({ web_search_requests: 1 })
  })

  it("returns just text when the backend produced no sources", async () => {
    webSearchFlowDependencies.createResponses = (() =>
      Promise.resolve(
        makeResponsesResult({
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "No results.", annotations: [] },
              ],
            },
          ] as never,
        }),
      )) as never
    webSearchFlowDependencies.createUsageRecorder = (() => () => {}) as never

    const { c, captured } = makeContext()
    await handleWebSearchViaResponses(c, makePayload(), baseOptions)

    const response = captured.json as AnthropicResponse
    expect(response.content.map((b) => b.type as string)).toEqual(["text"])
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
    expect(types.slice(1, 4)).toEqual([
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ])
    expect(types.slice(4, 6)).toEqual([
      "content_block_start",
      "content_block_stop",
    ])
    expect(types.slice(6, 9)).toEqual([
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ])
  })
})
