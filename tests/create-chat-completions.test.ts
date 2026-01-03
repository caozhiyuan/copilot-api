import { test, expect, mock } from "bun:test"

import { getReasoningEffortForModel } from "../src/lib/config"
import { state } from "../src/lib/state"
import {
  createChatCompletions,
  type ChatCompletionsPayload,
} from "../src/services/copilot/create-chat-completions"

type FetchOpts = {
  headers: Record<string, string>
  body?: string
}

// Mock state
state.githubToken = "test-github-token"
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Helper to mock fetch
const fetchMock = mock((_url: string, opts: FetchOpts) => {
  return {
    ok: true,
    json: () => ({ id: "123", object: "chat.completion", choices: [] }),
    headers: opts.headers,
  }
})
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

function getLastFetchCall(): FetchOpts {
  const last = fetchMock.mock.calls.at(-1)?.[1]

  expect(last).toBeTruthy()
  return last as FetchOpts
}

function getLastUpstreamPayload(): Record<string, unknown> {
  const { body } = getLastFetchCall()
  expect(body).toBeTruthy()
  return JSON.parse(body as string) as Record<string, unknown>
}

test("sets X-Initiator to agent if tool/assistant present", async () => {
  const callCountBefore = fetchMock.mock.calls.length

  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }

  await createChatCompletions(payload)

  expect(fetchMock.mock.calls.length).toBe(callCountBefore + 1)
  const { headers } = getLastFetchCall()
  expect(headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to user if only user present", async () => {
  const callCountBefore = fetchMock.mock.calls.length

  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }

  await createChatCompletions(payload)

  expect(fetchMock.mock.calls.length).toBe(callCountBefore + 1)
  const { headers } = getLastFetchCall()
  expect(headers["X-Initiator"]).toBe("user")
})

test("injects reasoning_effort from config for gpt-5-mini when omitted", async () => {
  const callCountBefore = fetchMock.mock.calls.length

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5-mini",
  }

  await createChatCompletions(payload)

  expect(fetchMock.mock.calls.length).toBe(callCountBefore + 1)
  const upstreamPayload = getLastUpstreamPayload()
  expect(upstreamPayload["reasoning_effort"]).toBe(
    getReasoningEffortForModel("gpt-5-mini"),
  )
})

test("does not override explicit reasoning_effort for gpt-5-mini", async () => {
  const callCountBefore = fetchMock.mock.calls.length

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5-mini",
    reasoning_effort: "high",
  }

  await createChatCompletions(payload)

  expect(fetchMock.mock.calls.length).toBe(callCountBefore + 1)
  const upstreamPayload = getLastUpstreamPayload()
  expect(upstreamPayload["reasoning_effort"]).toBe("high")
})

test("passes through reasoning_effort for non-gpt-5-mini models", async () => {
  const callCountBefore = fetchMock.mock.calls.length

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
    reasoning_effort: "low",
  }

  await createChatCompletions(payload)

  expect(fetchMock.mock.calls.length).toBe(callCountBefore + 1)
  const upstreamPayload = getLastUpstreamPayload()
  expect(upstreamPayload["reasoning_effort"]).toBe("low")
})

test("does not inject reasoning_effort for non-gpt-5-mini models when omitted", async () => {
  const callCountBefore = fetchMock.mock.calls.length

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
  }

  await createChatCompletions(payload)

  expect(fetchMock.mock.calls.length).toBe(callCountBefore + 1)
  const upstreamPayload = getLastUpstreamPayload()
  expect(Object.hasOwn(upstreamPayload, "reasoning_effort")).toBe(false)
})

test("injects reasoning_effort for gpt-5-mini variant models when omitted", async () => {
  const callCountBefore = fetchMock.mock.calls.length

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5-mini-2026-01-01",
  }

  await createChatCompletions(payload)

  expect(fetchMock.mock.calls.length).toBe(callCountBefore + 1)
  const upstreamPayload = getLastUpstreamPayload()
  expect(upstreamPayload["reasoning_effort"]).toBe(
    getReasoningEffortForModel("gpt-5-mini"),
  )
})
