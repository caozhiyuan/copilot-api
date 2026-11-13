import { describe, expect, test } from "bun:test"

import type { ResponseInputItem } from "~/lib/types/responses"
import { translateResponsesToMessages } from "~/routes/responses/messages-translation"
import { translateToOpenAI } from "~/routes/messages/completions-translation"

const pageContext = (overrides: Record<string, unknown> = {}) => ({
  type: "function_call_output",
  namespace: "agent",
  name: "codex_apps_open_page",
  output: '{"page_id":null}',
  ...overrides,
})

const translate = (input: Array<ResponseInputItem>) =>
  translateResponsesToMessages(
    { model: "gemini-test", input },
    { model: "gemini-test" },
  ).messagesPayload

describe("Codex injected page context", () => {
  test("preserves open and multipart selected page snapshots as user context", () => {
    const result = translate([
      { type: "message", role: "developer", content: "Base instructions" },
      pageContext(),
      pageContext({
        name: "codex_apps_selected_page_part_1_of_2",
        output: "Companion Page snapshot part 1 of 2:\nFirst part",
      }),
      pageContext({
        name: "codex_apps_selected_page_part_2_of_2",
        output: "Companion Page snapshot part 2 of 2:\nSecond part",
      }),
      { type: "message", role: "user", content: "hi" },
    ])

    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "agent.codex_apps_open_page:" },
          { type: "text", text: '{"page_id":null}' },
          {
            type: "text",
            text: "agent.codex_apps_selected_page_part_1_of_2:",
          },
          {
            type: "text",
            text: "Companion Page snapshot part 1 of 2:\nFirst part",
          },
          {
            type: "text",
            text: "agent.codex_apps_selected_page_part_2_of_2:",
          },
          {
            type: "text",
            text: "Companion Page snapshot part 2 of 2:\nSecond part",
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
        ],
      },
    ])
    expect(JSON.stringify(result.system)).not.toContain("page_id")
    const completions = translateToOpenAI(result)
    expect(
      completions.messages.some((message) => message.role === "tool"),
    ).toBe(false)
    expect(JSON.stringify(completions.messages)).toContain("First part")
    expect(JSON.stringify(completions.messages)).toContain("Second part")
  })

  test.each([
    {
      namespace: "codex_app",
      name: "send_message_to_thread",
      output:
        "<codex_delegation>\n  <source_thread_id>t-1</source_thread_id>\n  <input>Verify host</input>\n</codex_delegation>",
    },
    {
      namespace: "codex_app",
      name: "create_thread",
      output: "<codex_delegation><input>Init</input></codex_delegation>",
    },
    {
      namespace: "codex_app",
      name: "handoff_thread",
      output: "<codex_delegation><input>Handoff</input></codex_delegation>",
    },
    {
      namespace: "cloud_threads",
      name: "send_message",
      output: "<codex_delegation><input>Cloud</input></codex_delegation>",
    },
    {
      namespace: "agent",
      name: "ide_context",
      output: "Active file: src/main.ts",
    },
    {
      namespace: "agent",
      name: "codex_apps_writing_block_edits_part_1_of_2",
      output: "Writing block edit part 1",
    },
    {
      namespace: "agent",
      name: "future_context",
      output: "A new Desktop context snapshot",
    },
    {
      namespace: "slack",
      name: "notifications",
      output: "Alice mentioned you.",
    },
  ])(
    "preserves injected $namespace.$name outputs without call IDs",
    ({ namespace, name, output }) => {
      const result = translate([pageContext({ namespace, name, output })])
      expect(result.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: `${namespace}.${name}:` },
            {
              type: "text",
              text: output,
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ])
    },
  )

  test.each([
    { namespace: "codex_app", name: "create_thread" },
    { namespace: "codex_app", name: "send_message_to_thread" },
    { namespace: "codex_app", name: "handoff_thread" },
    { namespace: "cloud_threads", name: "send_message" },
  ])(
    "keeps later developer updates after $namespace.$name in messages",
    ({ namespace, name }) => {
      const result = translate([
        { type: "message", role: "developer", content: "Initial instructions" },
        pageContext({
          namespace,
          name,
          output:
            "<codex_delegation><input>First task</input></codex_delegation>",
        }),
        { type: "message", role: "assistant", content: "Done" },
        {
          type: "message",
          role: "developer",
          content: "<model_instructions>Switched model</model_instructions>",
        },
        pageContext({
          namespace,
          name,
          output:
            "<codex_delegation><input>Second task</input></codex_delegation>",
        }),
      ])
      expect(result.system).toEqual([
        {
          type: "text",
          text: "Initial instructions",
          cache_control: { type: "ephemeral" },
        },
      ])
      expect(JSON.stringify(result.messages)).toContain("Switched model")
    },
  )

  test.each([
    { namespace: "agent", name: "codex_apps_open_page" },
    { namespace: "agent", name: "future_context" },
    { namespace: "slack", name: "notifications" },
    { namespace: "codex_app", name: "list_threads" },
    { namespace: "cloud_threads", name: "list_threads" },
  ])(
    "treats $namespace.$name context as a user boundary for developer updates",
    (identity) => {
      const result = translate([
        { type: "message", role: "developer", content: "Initial instructions" },
        pageContext(identity),
        {
          type: "message",
          role: "developer",
          content: "More initial instructions",
        },
        { type: "message", role: "user", content: "hi" },
      ])
      expect(JSON.stringify(result.system)).not.toContain(
        "More initial instructions",
      )
      expect(JSON.stringify(result.messages)).toContain(
        "More initial instructions",
      )
    },
  )

  test("skips historical web_search_call items when switching a GPT thread to Messages", () => {
    const result = translate([
      { type: "message", role: "user", content: "Look up PR 500" },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Searching" }],
        encrypted_content: "enc-1",
      },
      {
        type: "web_search_call",
        id: "ws-1",
        status: "completed",
        action: { type: "open_page", url: "https://example.com" },
      },
      { type: "message", role: "assistant", content: "Checked PR 500" },
      pageContext({
        namespace: "codex_app",
        name: "send_message_to_thread",
        output: "<codex_delegation><input>Continue</input></codex_delegation>",
      }),
    ])
    expect(result.messages).toHaveLength(3)
    expect(result.messages[1].role).toBe("assistant")
    expect(result.messages[2].role).toBe("user")
  })

  test("preserves array content and images while omitting empty text blocks", () => {
    const result = translate([
      pageContext({
        call_id: null,
        output: [
          { type: "input_text", text: "" },
          { type: "input_text", text: "Selected content" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        ],
      }),
      { type: "message", role: "user", content: "Describe it" },
    ])
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "agent.codex_apps_open_page:" },
      { type: "text", text: "Selected content" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
      },
    ])
  })

  test.each(
    ["", null, undefined, [], [{ type: "input_text", text: "" }]].map(
      (output) => ({ output }),
    ),
  )(
    "accepts empty context output %j without creating empty text blocks",
    ({ output }) => {
      const result = translate([pageContext({ output })])
      expect(result.messages[0].content).toEqual([
        {
          type: "text",
          text: "agent.codex_apps_open_page:",
          cache_control: { type: "ephemeral" },
        },
      ])
    },
  )

  test.each([
    { name: undefined },
    { name: null },
    { name: "" },
    { name: " " },
    { name: 123 },
    { namespace: undefined },
    { namespace: null },
    { namespace: "" },
    { namespace: " " },
    { namespace: 123 },
    { type: "custom_tool_call_output" },
    { call_id: "" },
    { call_id: 123 },
  ])("rejects malformed ordinary tool results %j", (overrides) => {
    expect(() => translate([pageContext(overrides)])).toThrow(
      `${overrides.type ?? "function_call_output"}.call_id is required`,
    )
  })

  test("keeps results with call IDs linked to real tool calls", () => {
    const result = translate([
      {
        type: "function_call",
        namespace: "agent",
        name: "codex_apps_open_page",
        call_id: "call-page",
        arguments: "{}",
      },
      pageContext({ call_id: "call-page" }),
    ])
    expect(result.messages[1].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call-page",
        content: '{"page_id":null}',
        is_error: false,
        cache_control: { type: "ephemeral" },
      },
    ])
  })

  test("still validates injected output content", () => {
    expect(() => translate([pageContext({ output: 123 })])).toThrow(
      "function_call_output.output must be text or an array",
    )
  })
})
