import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { requestContext, type RequestTiming } from "~/lib/request-context"
import { requestEventsMiddleware } from "~/lib/request-events"
import { traceIdMiddleware } from "~/lib/trace"
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
let requestTiming: RequestTiming | undefined

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  createChatCompletions.mockReset()
  requestTiming = undefined
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
  const body = await response.text()
  expect(body).toContain("partial")
  expect(body).toContain("event: error")
  expect(body).toContain('"code":"upstream_stream_error"')
  expect(body).not.toContain("[DONE]")
  expect(requestTiming?.outcome).toBe("error")

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
  expect(body).not.toContain("event: error")
  expect(requestTiming?.outcome).toBe("completed")

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

test("native chat completions reports missing DONE and retains partial usage", async () => {
  createChatCompletions.mockResolvedValueOnce(
    streamChunks([
      chunk({
        content: "partial",
        usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
      }),
    ]),
  )
  const response = await requestCompletion()
  const body = await response.text()
  expect(body).toContain("partial")
  expect(body).toContain("event: error")
  expect(body).toContain('"code":"incomplete_stream"')
  expect(requestTiming?.outcome).toBe("error")
  const events = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "today",
  })
  expect(events.items).toHaveLength(1)
  expect(events.items[0]).toMatchObject({ input_tokens: 6, output_tokens: 3 })
})

test("native chat completions tracks JSON-only upstream errors as failures", async () => {
  createChatCompletions.mockResolvedValueOnce(
    streamChunks([
      { data: '{"error":{"message":"overloaded","type":"api_error"}}' },
      { data: "[DONE]" },
    ]),
  )
  const response = await requestCompletion()
  const body = await response.text()
  expect(body).toContain("event: error")
  expect(body).toContain("overloaded")
  expect(body).not.toContain("incomplete_stream")
  expect(requestTiming?.outcome).toBe("error")
})

test("native chat completions drains final usage after the client disconnects", async () => {
  let releaseUsage = () => {}
  const usageReady = new Promise<void>((resolve) => {
    releaseUsage = resolve
  })
  let finishUpstream = () => {}
  const upstreamFinished = new Promise<void>((resolve) => {
    finishUpstream = resolve
  })
  async function* upstream() {
    try {
      yield { data: '{"choices":[{"delta":{"content":"partial"}}]}' }
      await usageReady
      yield chunk({
        content: "",
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      })
      yield { data: "[DONE]" }
    } finally {
      finishUpstream()
    }
  }
  createChatCompletions.mockResolvedValueOnce(upstream())
  const response = await requestCompletion()
  const reader = response.body!.getReader()
  try {
    expect((await reader.read()).done).toBe(false)
    await reader.cancel()
  } finally {
    releaseUsage()
  }
  await upstreamFinished
  // The route records usage after the source iterator has returned.
  for (let attempt = 0; attempt < 50 && !requestTiming?.hasUsage; attempt++) {
    await Bun.sleep(1)
  }
  expect(requestTiming?.hasUsage).toBe(true)
  expect(requestTiming?.outcome).toBe("cancelled")
  const events = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "today",
  })
  expect(events.items).toHaveLength(1)
  expect(events.items[0]).toMatchObject({ input_tokens: 12, output_tokens: 7 })
})

const requestCompletion = async (): Promise<Response> => {
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.use(requestEventsMiddleware(undefined, 4141))
  app.use(async (_c, next) => {
    requestTiming = requestContext.getStore()?.requestTiming
    await next()
  })
  app.post("/v1/chat/completions", handleCompletion)
  return app.request("/v1/chat/completions", {
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
