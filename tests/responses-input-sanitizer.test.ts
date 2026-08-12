import { describe, expect, test } from "bun:test"

import type { ResponsesPayload } from "~/lib/types/responses"

import { sanitizeUnsupportedInputFields } from "~/routes/responses/utils"

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
