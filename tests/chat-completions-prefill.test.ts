import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"

import { assistantPrefillState } from "~/lib/assistant-prefill"
import { state } from "~/lib/state"
import { closeUsageStore } from "~/lib/token-usage"
import { handleCompletion } from "~/routes/chat-completions/handler"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const originalFetch = globalThis.fetch
const originalCopilotToken = state.copilotToken
const originalDbPath = process.env[DB_PATH_ENV]

const prefillRejection = () =>
  Response.json(
    {
      error: {
        message:
          "This model does not support assistant message prefill. The conversation must end with a user message.",
        code: "invalid_request_body",
      },
    },
    { status: 400 },
  )
const completion = () =>
  Response.json({ id: "123", object: "chat.completion", choices: [] })

const fetchMock = mock((_url: string, _init?: RequestInit) =>
  Promise.resolve(completion()),
)

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  state.copilotToken = "test-token"
  assistantPrefillState.rejectingModels.clear()
  fetchMock.mockClear()
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  state.copilotToken = originalCopilotToken
  await closeUsageStore()
  if (originalDbPath === undefined) {
    delete process.env[DB_PATH_ENV]
  } else {
    process.env[DB_PATH_ENV] = originalDbPath
  }
})

test("retries a rejected prefill with a trailing user turn and keeps the agent initiator", async () => {
  fetchMock.mockImplementationOnce(() => Promise.resolve(prefillRejection()))
  const app = new Hono()
  app.post("/", handleCompletion)

  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "no-prefill-model",
      max_tokens: 16,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "partial" },
      ],
    } satisfies ChatCompletionsPayload),
  })

  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(2)

  const [first, retry] = fetchMock.mock.calls.map(([, init]) => ({
    initiator: (init?.headers as Record<string, string>)["x-initiator"],
    roles: (
      JSON.parse(init?.body as string) as ChatCompletionsPayload
    ).messages.map((message) => message.role),
  }))
  expect(first).toEqual({ initiator: "agent", roles: ["user", "assistant"] })
  expect(retry).toEqual({
    initiator: "agent",
    roles: ["user", "assistant", "user"],
  })
})
