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
    { name: "read_file" },
    { name: undefined },
    { name: "codex_apps_selected_page_part_0_of_1" },
    { name: "codex_apps_selected_page_part_1_of_1_extra" },
    { namespace: "functions" },
    { namespace: undefined },
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
