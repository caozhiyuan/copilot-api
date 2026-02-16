import { expect, mock, test } from "bun:test"

import type { AccountContext } from "../src/lib/types/account"
import type {
  AnthropicMessagesPayload,
  AnthropicUserMessage,
} from "../src/routes/messages/anthropic-types"

import { createMessages } from "../src/services/copilot/create-messages"

type FetchOpts = {
  headers: Record<string, string>
  body?: string
}

const accountContext: AccountContext = {
  githubToken: "test-github-token",
  copilotToken: "test-copilot-token",
  accountType: "individual",
  vsCodeVersion: "1.0.0",
}

const fetchMock = mock((_url: string, opts: FetchOpts) => {
  return {
    ok: true,
    json: () => ({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [],
      model: "copilot/gpt-5.2",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    }),
    headers: opts.headers,
  }
})

// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

const basePayload = (
  content: AnthropicUserMessage["content"],
): AnthropicMessagesPayload => ({
  model: "copilot/gpt-5.2",
  max_tokens: 64,
  messages: [{ role: "user", content }],
})

function getLastHeaders(): Record<string, string> {
  const lastCall = fetchMock.mock.calls.at(-1)
  expect(lastCall).toBeTruthy()
  if (!lastCall) {
    throw new Error("Expected fetch to be called at least once")
  }

  return lastCall[1].headers
}

test("respects explicit initiator override", async () => {
  const payload = basePayload([{ type: "text", text: "hello" }])

  await createMessages(payload, accountContext, {
    initiator: "agent",
  })

  expect(getLastHeaders()["X-Initiator"]).toBe("agent")
})

test("falls back to user initiator for regular user prompt", async () => {
  const payload = basePayload([{ type: "text", text: "hello" }])

  await createMessages(payload, accountContext)

  expect(getLastHeaders()["X-Initiator"]).toBe("user")
})

test("falls back to agent initiator for pure tool_result continuation", async () => {
  const payload = basePayload([
    {
      type: "tool_result",
      tool_use_id: "tool_1",
      content: "ok",
    },
  ])

  await createMessages(payload, accountContext)

  expect(getLastHeaders()["X-Initiator"]).toBe("agent")
})
