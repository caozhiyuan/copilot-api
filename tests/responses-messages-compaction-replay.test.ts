import { describe, expect, test } from "bun:test"

import type { ResponsesPayload } from "~/lib/types/responses"
import {
  encodeMessagesCompaction,
  MESSAGES_COMPACTION_PREFIX,
} from "~/routes/responses/messages-translation"
import { COMPACTION_REPLAY_PROMPT } from "~/routes/responses/messages-translation/constants"
import { replayMessagesCompactionForResponses } from "~/routes/responses/utils"

describe("Messages compaction replay for native Responses", () => {
  const summary = "已确认用户允许读取文件。\nNext: inspect src/main.ts."
  const replay = {
    type: "message",
    role: "user",
    content: `${COMPACTION_REPLAY_PROMPT}${summary}`,
  }

  test.each([
    encodeMessagesCompaction(summary),
    `${MESSAGES_COMPACTION_PREFIX}${Buffer.from(summary).toString("base64url")}`,
  ])("replays gateway checkpoints as text: %s", (encryptedContent) => {
    const developer = {
      role: "developer",
      content: "Review the pending action",
    }
    const toolCall = {
      type: "function_call",
      call_id: "call-1",
      name: "exec_command",
      arguments: '{"cmd":"Get-Content src/main.ts"}',
    }
    const toolResult = {
      type: "function_call_output",
      call_id: "call-1",
      output: "file contents",
    }
    const input = [
      developer,
      {
        type: "compaction",
        id: "cmp-messages",
        encrypted_content: encryptedContent,
      },
      toolCall,
      toolResult,
    ]
    const payload: ResponsesPayload = { model: "codex-auto-review", input }

    replayMessagesCompactionForResponses(payload)

    expect(payload.input).toEqual([developer, replay, toolCall, toolResult])
    expect(input[1]).toHaveProperty("encrypted_content", encryptedContent)
  })

  test("preserves native and malformed checkpoints alongside gateway summaries", () => {
    const native = {
      type: "compaction",
      id: "cmp-native",
      encrypted_content: "native-ciphertext",
    }
    const malformed = { type: "compaction", encrypted_content: 123 }
    const payload: ResponsesPayload = {
      model: "gpt-test",
      input: [
        native,
        {
          type: "compaction",
          id: "cmp-messages",
          encrypted_content: encodeMessagesCompaction(summary),
        },
        malformed,
      ],
    }

    replayMessagesCompactionForResponses(payload)

    expect(payload.input).toEqual([native, replay, malformed])
    expect((payload.input as Array<unknown>)[0]).toBe(native)
    expect((payload.input as Array<unknown>)[2]).toBe(malformed)
  })

  test.each([{ input: undefined }, { input: "hello" }, { input: [] }])(
    "keeps input without checkpoints: %j",
    ({ input }) => {
      const payload: ResponsesPayload = { model: "gpt-test", input }

      replayMessagesCompactionForResponses(payload)

      expect(payload.input).toEqual(input)
    },
  )
})
