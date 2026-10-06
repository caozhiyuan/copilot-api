import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"

import { state } from "~/lib/state"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
}

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => {
    return {
      ok: true,
      json: () => ({ id: "123", object: "chat.completion", choices: [] }),
      headers: opts.headers,
    }
  },
)
beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  state.copilotToken = originalState.copilotToken
  state.vsCodeVersion = originalState.vsCodeVersion
  state.accountType = originalState.accountType
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("sets x-initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload, { requestId: "1" })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["x-initiator"]).toBe("agent")
})

test("sets x-initiator to user if only user present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload, { requestId: "1" })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["x-initiator"]).toBe("user")
})

test("uses an explicit initiator instead of inferring it from the last message", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
  }
  await createChatCompletions(payload, { requestId: "1", initiator: "agent" })
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["x-initiator"]).toBe("agent")
})
