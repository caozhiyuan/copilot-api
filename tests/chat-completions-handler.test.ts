import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { ChatCompletionChunk } from "~/lib/types/chat-completions"

process.env.COPILOT_API_HOME = mkdtempSync(
  path.join(tmpdir(), "copilot-api-chat-"),
)
process.env.COPILOT_API_SQLITE_DB_PATH = ":memory:"

const { chatCompletionsHandlerDependencies, handleCompletion } = await import(
  "~/routes/chat-completions/handler"
)
const { closeUsageStore, getTokenUsageEventsPage } = await import(
  "~/lib/token-usage"
)

const originalCreateChatCompletions =
  chatCompletionsHandlerDependencies.createChatCompletions
const createChatCompletions = mock(originalCreateChatCompletions)

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  createChatCompletions.mockReset()
  chatCompletionsHandlerDependencies.createChatCompletions =
    createChatCompletions
})

afterEach(async () => {
  chatCompletionsHandlerDependencies.createChatCompletions =
    originalCreateChatCompletions
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
})

test("native chat completions stream records usage when the upstream iterator throws", async () => {
  createChatCompletions.mockImplementationOnce(() =>
    Promise.resolve(
      streamChunks([
        chunk({
          content: "partial",
          usage: {
            completion_tokens: 2,
            prompt_tokens: 5,
            total_tokens: 7,
          },
        }),
        { error: new Error("upstream connection reset") },
      ]),
    ),
  )
  const response = await requestCompletion()
  expect(response.status).toBe(200)
  expect(await response.text()).toContain("partial")

  const usageEvents = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "today",
  })
  expect(usageEvents.items).toHaveLength(1)
  expect(usageEvents.items[0]).toMatchObject({
    endpoint: "chat_completions",
    input_tokens: 5,
    model: "gpt-test",
    output_tokens: 2,
    total_tokens: 7,
  })
})

test("native chat completions stream records usage after an invalid JSON chunk", async () => {
  createChatCompletions.mockImplementationOnce(() =>
    Promise.resolve(
      streamChunks([
        { data: "not-json" },
        chunk({
          content: "after",
          usage: {
            completion_tokens: 3,
            prompt_tokens: 8,
            total_tokens: 11,
          },
        }),
        { data: "[DONE]" },
      ]),
    ),
  )

  const response = await requestCompletion()
  expect(response.status).toBe(200)
  const body = await response.text()
  expect(body).toContain("after")

  const usageEvents = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "today",
  })
  expect(usageEvents.items).toHaveLength(1)
  expect(usageEvents.items[0]).toMatchObject({
    input_tokens: 8,
    output_tokens: 3,
    total_tokens: 11,
  })
})

const requestCompletion = async (): Promise<Response> => {
  const app = new Hono()
  app.post("/", handleCompletion)
  return app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      model: "gpt-test",
      stream: true,
    }),
  })
}

const chunk = (input: {
  content: string
  usage: {
    completion_tokens: number
    prompt_tokens: number
    total_tokens: number
  }
}): { data: string } => {
  const payload: ChatCompletionChunk = {
    choices: [
      {
        delta: { content: input.content },
        finish_reason: null,
        index: 0,
        logprobs: null,
      },
    ],
    created: 0,
    id: "chatcmpl-test",
    model: "gpt-test",
    object: "chat.completion.chunk",
    usage: input.usage,
  }
  return { data: JSON.stringify(payload) }
}

async function* streamChunks(
  chunks: Array<{ data?: string; error?: Error }>,
): AsyncGenerator<{ data: string }> {
  for (const chunk of chunks) {
    await Promise.resolve()
    if (chunk.error) {
      throw chunk.error
    }
    yield { data: chunk.data ?? "" }
  }
}
