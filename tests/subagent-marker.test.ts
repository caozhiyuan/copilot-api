import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { parseSubagentMarkerFromFirstUser } from "~/routes/messages/subagent-marker"

const basePayload = (
  messages: AnthropicMessagesPayload["messages"],
): AnthropicMessagesPayload => ({
  model: "copilot/gpt-5.2",
  max_tokens: 16,
  messages,
})

describe("parseSubagentMarkerFromFirstUser", () => {
  test("parses valid marker from first user system reminder", () => {
    const payload = basePayload([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<system-reminder>
SubagentStart hook additional context: __SUBAGENT_MARKER__{"session_id":"s-1","agent_id":"a-1","agent_type":"claude-subagent"}
</system-reminder>`,
          },
          {
            type: "text",
            text: "继续执行",
          },
        ],
      },
    ])

    expect(parseSubagentMarkerFromFirstUser(payload)).toEqual({
      session_id: "s-1",
      agent_id: "a-1",
      agent_type: "claude-subagent",
    })
  })

  test("parses marker when runtime appends a started line after json", () => {
    const payload = basePayload([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<system-reminder>
SubagentStart hook additional context: __SUBAGENT_MARKER__{"session_id":"s-1","agent_id":"a-1","agent_type":"claude-subagent"}
Agent Explore started (agent-1)
</system-reminder>`,
          },
        ],
      },
    ])

    expect(parseSubagentMarkerFromFirstUser(payload)).toEqual({
      session_id: "s-1",
      agent_id: "a-1",
      agent_type: "claude-subagent",
    })
  })

  test("parses marker when runtime appends multiple lines after json", () => {
    const payload = basePayload([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '<system-reminder>\nSubagentStart hook additional context: __SUBAGENT_MARKER__{"session_id":"s-2","agent_id":"a-2","agent_type":"claude \\"subagent\\""}\nAgent Explore started (agent-2)\nAdditional runtime note\n</system-reminder>',
          },
        ],
      },
    ])

    expect(parseSubagentMarkerFromFirstUser(payload)).toEqual({
      session_id: "s-2",
      agent_id: "a-2",
      agent_type: 'claude "subagent"',
    })
  })

  test("returns null when marker json is invalid", () => {
    const payload = basePayload([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>__SUBAGENT_MARKER__{invalid-json}</system-reminder>",
          },
        ],
      },
    ])

    expect(parseSubagentMarkerFromFirstUser(payload)).toBeNull()
  })

  test("returns null when marker json object is incomplete", () => {
    const payload = basePayload([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<system-reminder>
SubagentStart hook additional context: __SUBAGENT_MARKER__{"session_id":"s-1","agent_id":"a-1","agent_type":"claude-subagent"
Agent Explore started (agent-1)
</system-reminder>`,
          },
        ],
      },
    ])

    expect(parseSubagentMarkerFromFirstUser(payload)).toBeNull()
  })

  test("returns null when required fields are missing", () => {
    const payload = basePayload([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '<system-reminder>__SUBAGENT_MARKER__{"session_id":"s-1","agent_id":"a-1"}</system-reminder>',
          },
        ],
      },
    ])

    expect(parseSubagentMarkerFromFirstUser(payload)).toBeNull()
  })

  test("only checks the first user message", () => {
    const payload = basePayload([
      {
        role: "user",
        content: [{ type: "text", text: "普通用户消息" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "处理中" }],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '<system-reminder>__SUBAGENT_MARKER__{"session_id":"s-2","agent_id":"a-2","agent_type":"opencode-subagent"}</system-reminder>',
          },
        ],
      },
    ])

    expect(parseSubagentMarkerFromFirstUser(payload)).toBeNull()
  })
})
