import { describe, expect, test } from "bun:test"

import { prepareResponsesContinuation } from "~/lib/responses-continuation"
import {
  formatToolSearchArguments,
  resolveResponsesToolSearchMode,
} from "~/lib/tool-search"
import type {
  AnthropicInputMessage,
  AnthropicMessagesPayload,
  AnthropicTool,
} from "~/lib/types/anthropic"
import type {
  ResponseInputItem,
  ResponseStreamEvent,
  ResponseToolSearchOutputItem,
  ResponsesResult,
} from "~/lib/types/responses"
import {
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"

const searchTool: AnthropicTool = {
  name: "ToolSearch",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      max_results: { type: "number", default: 5 },
    },
    required: ["query", "max_results"],
    additionalProperties: false,
  },
}
const placeholder: AnthropicTool = {
  name: "DeferredToolPlaceholder",
  description: "Never call this placeholder",
  input_schema: { type: "object", properties: {} },
  defer_loading: true,
}
const readTool: AnthropicTool = {
  name: "Read",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
}
const deferredTool = (name: string, version = 1): AnthropicTool => ({
  name,
  description: `Tool ${name}, version ${version}`,
  input_schema: {
    type: "object",
    properties: { value: { type: version === 1 ? "string" : "number" } },
    required: ["value"],
    additionalProperties: false,
  },
  defer_loading: true,
})
const issue = deferredTool("mcp__probe__get_issue")
const user = deferredTool("mcp__probe__get_user")
const searchCall = (id: string, query: string): AnthropicInputMessage => ({
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id,
      name: "ToolSearch",
      input: { query, max_results: 5 },
    },
  ],
})
const searchResult = (
  id: string,
  names: Array<string>,
): AnthropicInputMessage => ({
  role: "user",
  content: [
    {
      type: "tool_result",
      tool_use_id: id,
      content: names.map((tool_name) => ({
        type: "tool_reference",
        tool_name,
      })),
    },
  ],
})
const initialMessage = {
  role: "user",
  content:
    "Available deferred tools: mcp__probe__get_issue, mcp__probe__get_user",
} satisfies AnthropicInputMessage
const makePayload = (
  messages: Array<AnthropicInputMessage>,
  selected: Array<AnthropicTool> = [],
): AnthropicMessagesPayload => ({
  model: "gpt-6.1-sol",
  max_tokens: 1024,
  messages,
  tools: [readTool, searchTool, placeholder, ...selected],
})
const searchOutputs = (input: ResponseInputItem[]) =>
  input.filter(
    (item): item is ResponseToolSearchOutputItem =>
      item.type === "tool_search_output",
  )

describe("Claude Code native tool search", () => {
  test("starts client search without the deferred catalog or placeholder", () => {
    const payload = makePayload([initialMessage])
    const translated = translateAnthropicMessagesToResponsesPayload(payload)

    expect(translated.tools).toEqual([
      {
        type: "function",
        name: "Read",
        parameters: readTool.input_schema,
        strict: false,
      },
      {
        type: "tool_search",
        execution: "client",
        description: expect.stringContaining("Claude Code ToolSearch"),
        parameters: searchTool.input_schema,
      },
    ])
    expect(translated.input).toEqual([
      { type: "message", role: "user", content: initialMessage.content },
    ])
    expect(translated.store).toBe(false)
    expect(translated.include).toContain("reasoning.encrypted_content")
  })

  test("loads multiple references in order and preserves normal tool calls", () => {
    const payload = makePayload(
      [
        initialMessage,
        searchCall(
          "search-1",
          "select:mcp__probe__get_issue,mcp__probe__get_user",
        ),
        searchResult("search-1", [issue.name, user.name]),
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "issue-call",
              name: issue.name,
              input: { value: "42" },
            },
            {
              type: "tool_use",
              id: "user-call",
              name: user.name,
              input: { value: "alice" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "issue-call",
              content: "issue",
            },
            { type: "tool_result", tool_use_id: "user-call", content: "user" },
          ],
        },
      ],
      [issue, user],
    )
    const translated = translateAnthropicMessagesToResponsesPayload(payload)
    const input = translated.input as ResponseInputItem[]
    expect(input[1]).toEqual({
      type: "tool_search_call",
      call_id: "search-1",
      execution: "client",
      status: "completed",
      arguments: {
        query: "select:mcp__probe__get_issue,mcp__probe__get_user",
        max_results: 5,
      },
    })
    expect(searchOutputs(input)[0]).toEqual({
      type: "tool_search_output",
      call_id: "search-1",
      execution: "client",
      status: "completed",
      tools: [
        {
          type: "function",
          name: issue.name,
          description: issue.description,
          parameters: issue.input_schema,
          strict: false,
          defer_loading: true,
        },
        {
          type: "function",
          name: user.name,
          description: user.description,
          parameters: user.input_schema,
          strict: false,
          defer_loading: true,
        },
      ],
    })
    expect(input.slice(3)).toEqual([
      {
        type: "function_call",
        call_id: "issue-call",
        name: issue.name,
        arguments: '{"value":"42"}',
        status: "completed",
      },
      {
        type: "function_call",
        call_id: "user-call",
        name: user.name,
        arguments: '{"value":"alice"}',
        status: "completed",
      },
      {
        type: "function_call_output",
        call_id: "issue-call",
        output: "issue",
        status: "completed",
      },
      {
        type: "function_call_output",
        call_id: "user-call",
        output: "user",
        status: "completed",
      },
    ])
    expect(translated.parallel_tool_calls).toBe(true)
    expect(translated.tools).toEqual(
      translateAnthropicMessagesToResponsesPayload(
        makePayload([initialMessage]),
      ).tools,
    )
  })

  test("deduplicates previously loaded tools and handles an empty search", () => {
    const payload = makePayload(
      [
        initialMessage,
        searchCall("search-1", "issue"),
        searchResult("search-1", [issue.name]),
        searchCall("search-2", "issue user"),
        searchResult("search-2", [issue.name, user.name, user.name]),
        searchCall("search-3", "no match"),
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "search-3",
              content: "No matching deferred tools found",
            },
          ],
        },
      ],
      [issue, user],
    )
    const input = translateAnthropicMessagesToResponsesPayload(payload)
      .input as ResponseInputItem[]
    expect(
      searchOutputs(input).map((output) =>
        output.tools.map((t) => ("name" in t ? t.name : undefined)),
      ),
    ).toEqual([[issue.name], [user.name], []])
    expect(searchOutputs(input).map((output) => output.call_id)).toEqual([
      "search-1",
      "search-2",
      "search-3",
    ])
  })

  test("keeps eagerly available tools out of search results", () => {
    const messages: Array<AnthropicInputMessage> = [
      initialMessage,
      searchCall("search-eager", "Read"),
      searchResult("search-eager", [readTool.name]),
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "read-call",
            name: readTool.name,
            input: { path: "test" },
          },
        ],
      },
    ]
    const input = translateAnthropicMessagesToResponsesPayload(
      makePayload(messages),
    ).input as ResponseInputItem[]
    expect(searchOutputs(input)[0].tools).toEqual([])
    expect(input.at(-1)).toMatchObject({
      type: "function_call",
      name: "Read",
      call_id: "read-call",
    })
    expect(input.at(-1)).not.toHaveProperty("namespace")
  })

  test("rejects missing, ambiguous, or placeholder definitions", () => {
    const messages = [
      initialMessage,
      searchCall("search-invalid", "select:missing"),
      searchResult("search-invalid", [issue.name]),
    ]
    expect(() =>
      translateAnthropicMessagesToResponsesPayload(makePayload(messages)),
    ).toThrow("no unambiguous tool definition")
    expect(() =>
      translateAnthropicMessagesToResponsesPayload(
        makePayload(messages, [issue, deferredTool(issue.name, 2)]),
      ),
    ).toThrow("no unambiguous tool definition")
    expect(() =>
      translateAnthropicMessagesToResponsesPayload(
        makePayload([
          initialMessage,
          searchCall("search-placeholder", "select:DeferredToolPlaceholder"),
          searchResult("search-placeholder", [placeholder.name]),
        ]),
      ),
    ).toThrow("no unambiguous tool definition")
  })

  test("replays the current schema after a tool definition changes", () => {
    const first = [
      initialMessage,
      searchCall("snapshot-1", "issue"),
      searchResult("snapshot-1", [issue.name]),
    ]
    const updated = deferredTool(issue.name, 2)
    const both = [
      ...first,
      searchCall("snapshot-2", "issue"),
      searchResult("snapshot-2", [issue.name]),
    ]

    translateAnthropicMessagesToResponsesPayload(makePayload(first, [issue]))
    const replay = translateAnthropicMessagesToResponsesPayload(
      makePayload(both, [updated]),
    )
    const outputs = searchOutputs(replay.input as ResponseInputItem[])
    expect(outputs[0].tools[0]).toMatchObject({
      parameters: updated.input_schema,
    })
    expect(outputs[1].tools).toEqual([])
  })

  test("uses native search only for supported models, including with a bridge installed", () => {
    const bridge: AnthropicTool = {
      name: "mcp__tool_search__search",
      input_schema: { type: "object" },
    }
    expect(
      resolveResponsesToolSearchMode({
        model: "gpt-6.1-sol",
        tools: [searchTool],
      }),
    ).toBe("native")
    expect(
      resolveResponsesToolSearchMode({ model: "gpt-5.3", tools: [searchTool] }),
    ).toBe("disabled")
    expect(
      resolveResponsesToolSearchMode({
        model: "claude-sonnet-4-6",
        tools: [searchTool],
      }),
    ).toBe("disabled")
    expect(
      resolveResponsesToolSearchMode({
        model: "gpt-6.1-sol",
        tools: [searchTool, bridge, placeholder],
      }),
    ).toBe("native")
    expect(
      resolveResponsesToolSearchMode({
        model: "gpt-6.1-sol",
        tools: [bridge, issue],
      }),
    ).toBe("bridge")

    const unsupported = translateAnthropicMessagesToResponsesPayload({
      ...makePayload([initialMessage]),
      model: "gpt-5.3",
    })
    expect(unsupported.tools?.some((tool) => tool.type === "tool_search")).toBe(
      false,
    )
  })

  test("replays bridge searches with native parameters when both tools are present", () => {
    const bridge: AnthropicTool = {
      name: "mcp__tool_search__search",
      input_schema: { type: "object" },
    }
    const messages: Array<AnthropicInputMessage> = [
      initialMessage,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "bridge-search",
            name: bridge.name,
            input: { names: issue.name },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "bridge-search",
            content: JSON.stringify({
              type: "copilot_api_tool_search",
              names: [issue.name],
            }),
          },
        ],
      },
    ]
    const translated = translateAnthropicMessagesToResponsesPayload(
      makePayload(messages, [bridge, issue]),
    )
    const input = translated.input as ResponseInputItem[]
    expect(input[1]).toMatchObject({
      type: "tool_search_call",
      call_id: "bridge-search",
      arguments: { query: `select:${issue.name}`, max_results: 5 },
    })
    expect(searchOutputs(input)[0].tools).toMatchObject([{ name: issue.name }])
    expect(() =>
      translateAnthropicMessagesToResponsesPayload(
        makePayload(messages, [bridge]),
      ),
    ).toThrow("no unambiguous tool definition")
  })

  test("preserves native query arguments in JSON and streaming responses", () => {
    const argumentsValue = {
      query: "select:mcp__probe__get_issue",
      max_results: 3,
    }
    const response: ResponsesResult = {
      id: "response-1",
      object: "response",
      created_at: 0,
      model: "gpt-6.1-sol",
      output: [
        {
          type: "tool_search_call",
          call_id: "search-1",
          arguments: argumentsValue,
        },
      ],
      output_text: "",
      status: "completed",
      usage: null,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: null,
      tools: [],
      top_p: null,
    }
    expect(
      translateResponsesResultToAnthropic(response, {
        toolSearchName: "ToolSearch",
      }).content,
    ).toEqual([
      {
        type: "tool_use",
        id: "search-1",
        name: "ToolSearch",
        input: argumentsValue,
      },
    ])
    expect(
      formatToolSearchArguments(JSON.stringify(argumentsValue), "ToolSearch"),
    ).toEqual(argumentsValue)
    expect(formatToolSearchArguments("invalid JSON", "ToolSearch")).toEqual({})

    const state = createResponsesStreamState({ toolSearchName: "ToolSearch" })
    const events = [
      translateResponsesStreamEvent(
        {
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 0,
          item: { type: "tool_search_call", call_id: "", arguments: {} },
        },
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.output_item.done",
          sequence_number: 2,
          output_index: 0,
          item: {
            type: "tool_search_call",
            call_id: "search-1",
            arguments: argumentsValue,
          },
        },
        state,
      ),
    ].flat()
    expect(events).toContainEqual({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "search-1",
        name: "ToolSearch",
        input: {},
      },
    })
    expect(events).toContainEqual({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(argumentsValue),
      },
    })

    const addedIdState = createResponsesStreamState({
      toolSearchName: "ToolSearch",
    })
    translateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: { type: "tool_search_call", call_id: "search-2", arguments: {} },
      },
      addedIdState,
    )
    const done = translateResponsesStreamEvent(
      {
        type: "response.output_item.done",
        sequence_number: 2,
        output_index: 0,
        item: {
          type: "tool_search_call",
          call_id: "",
          arguments: argumentsValue,
        },
      },
      addedIdState,
    )
    expect(done).toContainEqual({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(argumentsValue),
      },
    })
  })
})

test("continues a native search and replays its loaded definitions after reconnect", () => {
  const connection = { id: "native-socket", closed: false }
  const initial = translateAnthropicMessagesToResponsesPayload(
    makePayload([initialMessage]),
  )
  const first = prepareResponsesContinuation(initial, connection, false)
  first.observe({
    type: "response.completed",
    response: {
      id: "resp-search",
      status: "completed",
      output: [
        {
          type: "tool_search_call",
          call_id: "search-1",
          arguments: { query: "issue", max_results: 5 },
        },
      ],
    },
  } as unknown as ResponseStreamEvent)
  first.finish()

  const messages = [
    initialMessage,
    searchCall("search-1", "issue"),
    searchResult("search-1", [issue.name]),
  ]
  const full = translateAnthropicMessagesToResponsesPayload(
    makePayload(messages, [issue]),
  )
  const next = prepareResponsesContinuation(full, connection, false)
  expect(next.payload.previous_response_id).toBe("resp-search")
  expect(next.payload.input).toEqual([
    searchOutputs(full.input as ResponseInputItem[])[0],
  ])
  next.observe({
    type: "response.completed",
    response: {
      id: "resp-function",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "issue-call",
          name: issue.name,
          namespace: issue.name,
          arguments: '{"value":"42"}',
        },
      ],
    },
  } as unknown as ResponseStreamEvent)
  next.finish()

  const afterTool = translateAnthropicMessagesToResponsesPayload(
    makePayload(
      [
        ...messages,
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "issue-call",
              name: issue.name,
              input: { value: "42" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "issue-call",
              content: "issue 42",
            },
          ],
        },
      ],
      [issue],
    ),
  )
  const third = prepareResponsesContinuation(afterTool, connection, false)
  expect(third.payload.previous_response_id).toBe("resp-function")
  expect(third.payload.input).toEqual([
    {
      type: "function_call_output",
      call_id: "issue-call",
      output: "issue 42",
      status: "completed",
    },
  ])
  expect(prepareResponsesContinuation(full, connection, true).payload).toEqual(
    full,
  )
  expect(
    prepareResponsesContinuation(
      full,
      { id: "new-socket", closed: false },
      false,
    ).payload,
  ).toEqual(full)
})
