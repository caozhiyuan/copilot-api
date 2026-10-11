import { describe, expect, test } from "bun:test"

import type { ResponseInputItem, ResponsesPayload } from "~/lib/types/responses"

import {
  normalizeGuardianAgentMessages,
  sanitizeUnsupportedInputFields,
} from "~/routes/responses/utils"

describe("normalizeGuardianAgentMessages", () => {
  const createGuardianPayload = (): ResponsesPayload & {
    input: Array<ResponseInputItem>
  } => ({
    model: "gpt-5.5",
    prompt_cache_key: "guardian:01a12870-03e0-7331-8eec-2b0677454fba",
    text: {
      format: {
        type: "json_schema",
        name: "guardian_decision",
        schema: { type: "object" },
      },
    },
    input: [
      {
        id: "amsg-1",
        type: "agent_message",
        author: "agent-a",
        recipient: "agent-b",
        content: [
          { type: "input_text", text: "Agent handoff" },
          {
            type: "encrypted_content",
            encrypted_content: "encrypted-handoff",
          },
          { type: "input_text", text: "Planned action" },
        ],
      },
    ],
  })

  test("translates all agent messages and preserves other input items in order", () => {
    const payload = createGuardianPayload()
    const input = payload.input
    const developer = { type: "message", role: "developer", content: "Review" }
    const reasoning = {
      type: "reasoning",
      summary: [],
      encrypted_content: "encrypted-reasoning",
    }
    const user = { role: "user", content: "Continue" }
    payload.input = [
      developer,
      ...input,
      reasoning,
      ...structuredClone(input),
      user,
    ]

    expect(normalizeGuardianAgentMessages(payload)).toBe(2)
    const expectedUser = {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Agent handoff" },
        { type: "input_text", text: "Planned action" },
      ],
    }
    expect(payload.input).toEqual([
      developer,
      expectedUser,
      reasoning,
      expectedUser,
      user,
    ])
    expect(payload.input[0]).toBe(developer)
    expect(payload.input[2]).toBe(reasoning)
    expect(payload.input[4]).toBe(user)
    expect(normalizeGuardianAgentMessages(payload)).toBe(0)
  })

  test("matches the guardia prefix", () => {
    const payload = createGuardianPayload()
    payload.prompt_cache_key = "guardia:session"

    expect(normalizeGuardianAgentMessages(payload)).toBe(1)
  })

  test.each([
    undefined,
    null,
    "",
    "stable-cache-key",
    "xguardian:session",
    "Guardian:session",
  ])("keeps agent messages when prompt_cache_key is %j", (cacheKey) => {
    const payload = createGuardianPayload()
    payload.prompt_cache_key = cacheKey
    const originalInput = structuredClone(payload.input)

    expect(normalizeGuardianAgentMessages(payload)).toBe(0)
    expect(payload.input).toEqual(originalInput)
  })

  const nonSchemaTextConfigs: Array<ResponsesPayload["text"]> = [
    undefined,
    null,
    {},
    { format: null },
    { format: { type: "text" } },
    { format: { type: "json_object" } },
  ]
  test.each(nonSchemaTextConfigs)(
    "keeps agent messages when text config is %j",
    (text) => {
      const payload = createGuardianPayload()
      payload.text = text
      const originalInput = structuredClone(payload.input)

      expect(normalizeGuardianAgentMessages(payload)).toBe(0)
      expect(payload.input).toEqual(originalInput)
    },
  )

  test("handles missing, string and empty input", () => {
    const inputs: Array<ResponsesPayload["input"]> = [
      undefined,
      "Review action",
      [],
    ]
    for (const input of inputs) {
      const payload = { ...createGuardianPayload(), input }

      expect(normalizeGuardianAgentMessages(payload)).toBe(0)
      expect(payload.input).toEqual(input)
    }
  })

  test("discards content containing only encrypted blocks", () => {
    const payload = createGuardianPayload()
    payload.input = [
      {
        type: "agent_message",
        author: "agent-a",
        recipient: "agent-b",
        content: [
          { type: "encrypted_content", encrypted_content: "encrypted-only" },
        ],
      },
    ]

    expect(normalizeGuardianAgentMessages(payload)).toBe(1)
    expect(payload.input).toEqual([
      { type: "message", role: "user", content: [] },
    ])
  })
})

describe("sanitizeUnsupportedInputFields", () => {
  test("removes Codex internal_chat_message_metadata_passthrough from input items", () => {
    const payload = {
      input: [
        {
          content: [{ text: "hello", type: "input_text" }],
          internal_chat_message_metadata_passthrough: {
            turn_id: "turn-1",
          },
          role: "user",
        },
        {
          content: [{ text: "world", type: "input_text" }],
          role: "assistant",
        },
      ],
      model: "gpt-5.5",
    } as unknown as ResponsesPayload

    expect(sanitizeUnsupportedInputFields(payload)).toBe(1)
    expect(
      (payload.input as Array<Record<string, unknown>>)[0]
        .internal_chat_message_metadata_passthrough,
    ).toBeUndefined()
  })

  test("returns zero when input is missing or unsupported fields are absent", () => {
    expect(
      sanitizeUnsupportedInputFields({ model: "gpt-5.5" } as ResponsesPayload),
    ).toBe(0)
    expect(
      sanitizeUnsupportedInputFields({
        input: [{ content: "hello", role: "user" }],
        model: "gpt-5.5",
      } as ResponsesPayload),
    ).toBe(0)
  })
})
