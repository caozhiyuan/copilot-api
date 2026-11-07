import { describe, expect, spyOn, test } from "bun:test"
import type { ServerSentEventMessage } from "fetch-event-stream"

import { guardChatCompletionsStream } from "~/lib/chat-completions-stream"
import type { ChatCompletionChunk } from "~/lib/types/chat-completions"

const collect = async (
  chunks: Array<ServerSentEventMessage>,
  failure?: Error,
): Promise<Array<ServerSentEventMessage>> => {
  async function* source() {
    for (const chunk of chunks) {
      await Promise.resolve()
      yield chunk
    }
    if (failure) throw failure
  }

  const result: Array<ServerSentEventMessage> = []
  for await (const { message } of guardChatCompletionsStream(source())) {
    result.push(message)
  }
  return result
}

describe("native chat completion stream completion checks", () => {
  test("returns the parsed completion and parses each data chunk only once", async () => {
    const completion: ChatCompletionChunk = {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-test",
      choices: [],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }
    const data = JSON.stringify(completion)
    async function* source() {
      await Promise.resolve()
      yield { data }
      yield { data: "[DONE]" }
    }
    const parse = spyOn(JSON, "parse")
    try {
      const result = []
      for await (const event of guardChatCompletionsStream(source())) {
        result.push(event)
      }
      expect(result[0]).toEqual({ message: { data }, completion })
      expect(result[1]).toEqual({
        message: { data: "[DONE]" },
        completion: null,
      })
      expect(parse.mock.calls.filter(([value]) => value === data)).toHaveLength(
        1,
      )
    } finally {
      parse.mockRestore()
    }
  })

  test("preserves chunks and drains usage even after the terminal marker", async () => {
    const chunks = [
      { data: '{"choices":[{"delta":{"content":"hi"}}]}', id: "1" },
      { data: "[DONE]" },
      { data: '{"choices":[],"usage":{"total_tokens":12}}' },
    ]
    expect(await collect(chunks)).toEqual(chunks)
  })

  test("does not classify a transport error after DONE as incomplete", async () => {
    const chunks = [{ data: " [DONE] " }]
    expect(await collect(chunks, new Error("late close"))).toEqual(chunks)
  })

  test.each([{ chunks: [] }, { chunks: [{ data: '{"choices":[]}' }] }])(
    "reports clean EOF without DONE: %j",
    async ({ chunks }) => {
      const result = await collect(chunks)
      expect(result.slice(0, -1)).toEqual(chunks)
      expect(result.at(-1)?.event).toBe("error")
      expect(JSON.parse(result.at(-1)?.data ?? "")).toMatchObject({
        error: { type: "api_error", code: "incomplete_stream" },
      })
    },
  )

  test("converts iterator failures to one structured error", async () => {
    const result = await collect(
      [{ data: "partial" }],
      new Error("transport implementation details"),
    )
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ data: "partial" })
    expect(result[1].event).toBe("error")
    expect(JSON.parse(result[1].data ?? "")).toMatchObject({
      error: { type: "api_error", code: "upstream_stream_error" },
    })
    expect(result[1].data).not.toContain("implementation details")
  })

  test.each([
    { event: "error", data: "upstream failure" },
    { event: "error" },
    { data: '{"error":{"message":"rate limited","type":"rate_limit"}}' },
  ])(
    "forwards existing upstream errors without duplicates: %j",
    async (chunk) => {
      const expected = [{ ...chunk, event: "error" }]
      expect(await collect([chunk])).toEqual(expected)
      expect(await collect([chunk], new Error("connection reset"))).toEqual(
        expected,
      )
    },
  )

  test("preserves malformed JSON, comments and non-error JSON", async () => {
    const chunks = [
      { comment: "keepalive" },
      { data: "not-json" },
      { data: "null" },
      { data: '{"error":null,"choices":[]}' },
      { data: "42" },
      { data: '{"choices":[{"delta":{"content":"error"}}]}' },
      { data: "[DONE]" },
    ]
    expect(await collect(chunks)).toEqual(chunks)
  })

  test("still honors explicit error events when the JSON error field is null", async () => {
    const chunk = { event: "error", data: '{"error":null}' }
    expect(await collect([chunk])).toEqual([chunk])
  })
})
