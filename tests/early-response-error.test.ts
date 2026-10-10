import { describe, expect, mock, test } from "bun:test"

import { preflightResponseStream } from "~/routes/responses/early-response-error"

interface Chunk {
  data?: string
  event?: string
  id?: string
}
const chunk = (type: string, fields: Record<string, unknown> = {}): Chunk => ({
  event: type,
  data: JSON.stringify({ type, ...fields }),
})
const created = () => chunk("response.created", { response: { output: [] } })
const emptyFailure = () =>
  chunk("response.failed", {
    response: {
      error: null,
      output: [],
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  })
const message = "Encrypted content could not be decrypted or parsed."
const invalid = () =>
  chunk("error", { code: "invalid_request_body", message, param: null })
const completed = () =>
  chunk("response.completed", { response: { output: [] } })

async function* source(chunks: Array<Chunk>): AsyncGenerator<Chunk> {
  await Promise.resolve()
  yield* chunks
}
async function collect(stream: AsyncIterable<Chunk>): Promise<Array<Chunk>> {
  const output: Array<Chunk> = []
  for await (const item of stream) output.push(item)
  return output
}

describe("early Copilot Responses errors", () => {
  test("retains the real invalid-request error after an empty failed event", async () => {
    const input = [created(), emptyFailure(), invalid()]
    const result = await preflightResponseStream(source(input))
    expect(result.error).toEqual({
      type: "invalid_request_error",
      code: "invalid_request_body",
      message,
      param: null,
    })
    expect(result.buffered).toEqual(input)
    await result.close()
  })

  test.each(["bare", "nested", "failed"])(
    "recognizes an initial %s invalid-request error",
    async (shape) => {
      const error = { code: "invalid_request_error", message, param: "input" }
      const event =
        shape === "bare" ? chunk("error", error)
        : shape === "nested" ? chunk("error", { error })
        : chunk("response.failed", { response: { error, output: [] } })
      const result = await preflightResponseStream(
        source([created(), event, emptyFailure()]),
      )
      expect(result.error).toEqual({ ...error, type: "invalid_request_error" })
      await result.close()
    },
  )

  test("passes successful streams through without changing event order", async () => {
    const input = [
      created(),
      chunk("response.queued"),
      chunk("response.in_progress"),
      chunk("response.output_text.delta", { delta: "OK" }),
      completed(),
    ]
    const result = await preflightResponseStream(source(input))
    expect(result.error).toBeUndefined()
    expect(await collect(result.stream)).toEqual(input)
  })

  test("does not wait for a stream's completion once model output starts", async () => {
    const next = mock()
      .mockResolvedValueOnce({ done: false, value: created() })
      .mockResolvedValueOnce({
        done: false,
        value: chunk("response.output_item.added", {
          item: { type: "function_call" },
        }),
      })
    const close = mock(() =>
      Promise.resolve({ done: true as const, value: undefined }),
    )
    const result = await preflightResponseStream({
      [Symbol.asyncIterator]: () => ({ next, return: close }),
    })
    expect(next).toHaveBeenCalledTimes(2)
    await result.close()
    expect(close).toHaveBeenCalledTimes(1)
  })

  test.each(["text", "function", "failed-output"])(
    "does not turn a failure after %s output into HTTP 400",
    async (kind) => {
      const output =
        kind === "text" ?
          chunk("response.output_text.delta", { delta: "partial" })
        : kind === "function" ?
          chunk("response.output_item.added", {
            item: { type: "function_call" },
          })
        : chunk("response.failed", {
            response: {
              error: { code: "invalid_request_body", message },
              output: [{ type: "function_call" }],
            },
          })
      const input = [created(), output, emptyFailure(), invalid()]
      const result = await preflightResponseStream(source(input))
      expect(result.error).toBeUndefined()
      expect(await collect(result.stream)).toEqual(input)
    },
  )

  test.each(["server_error", "rate_limit_exceeded", "cyber_policy"])(
    "preserves %s failures without adding retries",
    async (code) => {
      const input = [
        created(),
        chunk("response.failed", {
          response: {
            error: { code, message: "upstream failure" },
            output: [],
          },
        }),
        chunk("error", { code, message: "upstream failure" }),
      ]
      const result = await preflightResponseStream(source(input))
      expect(result.error).toBeUndefined()
      expect(await collect(result.stream)).toEqual(input)
    },
  )

  test("preserves an empty terminal failure when no detailed error follows", async () => {
    const input = [created(), emptyFailure()]
    const result = await preflightResponseStream(source(input))
    expect(result.error).toBeUndefined()
    expect(await collect(result.stream)).toEqual(input)
  })

  test("keeps unknown or malformed events intact", async () => {
    for (const value of [
      {},
      { data: "not-json" },
      { data: "null" },
      { data: "[]" },
      { data: "[DONE]" },
      chunk("error", { code: "invalid_request_body", message: "" }),
    ]) {
      const input = [value, completed()]
      const result = await preflightResponseStream(source(input))
      expect(result.error).toBeUndefined()
      expect(await collect(result.stream)).toEqual(input)
    }
  })

  test("bounds both the number and the size of buffered events", async () => {
    for (const limits of [{ maxBufferedEvents: 1 }, { maxBufferedBytes: 1 }]) {
      const input = [created(), emptyFailure(), invalid()]
      const result = await preflightResponseStream(source(input), limits)
      expect(result.buffered).toHaveLength(1)
      expect(result.error).toBeUndefined()
      expect(await collect(result.stream)).toEqual(input)
    }
  })

  test("a preflight deadline preserves the outstanding read without reading twice", async () => {
    let resolveRead!: (result: IteratorResult<Chunk>) => void
    const pending = new Promise<IteratorResult<Chunk>>((resolve) => {
      resolveRead = resolve
    })
    const next = mock()
      .mockImplementationOnce(() => pending)
      .mockResolvedValueOnce({ done: false, value: completed() })
      .mockResolvedValueOnce({ done: true as const, value: undefined })
    const close = mock(() =>
      Promise.resolve({ done: true as const, value: undefined }),
    )
    const result = await preflightResponseStream(
      { [Symbol.asyncIterator]: () => ({ next, return: close }) },
      { timeoutMs: 5 },
    )
    expect(result.error).toBeUndefined()
    expect(next).toHaveBeenCalledTimes(1)
    resolveRead({ done: false, value: created() })
    expect(await collect(result.stream)).toEqual([created(), completed()])
    expect(next).toHaveBeenCalledTimes(3)
    expect(close).toHaveBeenCalledTimes(1)
  })

  test("bounds the wait for missing failure details and retains a delayed event", async () => {
    let resolveRead!: (result: IteratorResult<Chunk>) => void
    const pending = new Promise<IteratorResult<Chunk>>((resolve) => {
      resolveRead = resolve
    })
    const next = mock()
      .mockResolvedValueOnce({ done: false, value: emptyFailure() })
      .mockImplementationOnce(() => pending)
      .mockResolvedValueOnce({ done: true as const, value: undefined })
    const result = await preflightResponseStream(
      { [Symbol.asyncIterator]: () => ({ next }) },
      { timeoutMs: 100, errorDetailTimeoutMs: 5 },
    )
    expect(result.error).toBeUndefined()
    expect(next).toHaveBeenCalledTimes(2)
    resolveRead({ done: false, value: invalid() })
    expect(await collect(result.stream)).toEqual([emptyFailure(), invalid()])
    expect(next).toHaveBeenCalledTimes(3)
  })

  test("an expired deadline does not start an upstream read", async () => {
    const next = mock(() =>
      Promise.resolve({ done: true as const, value: undefined }),
    )
    const result = await preflightResponseStream(
      { [Symbol.asyncIterator]: () => ({ next }) },
      { timeoutMs: 0 },
    )
    expect(next).not.toHaveBeenCalled()
    await result.close()
  })

  test("propagates cancellation before and during a pending read", async () => {
    for (const alreadyAborted of [true, false]) {
      const controller = new AbortController()
      const reason = Object.assign(new Error("cancelled"), {
        name: "AbortError",
      })
      const close = mock(() =>
        Promise.resolve({ done: true as const, value: undefined }),
      )
      const next = mock(() => new Promise<IteratorResult<Chunk>>(() => {}))
      if (alreadyAborted) controller.abort(reason)
      const prepared = preflightResponseStream(
        { [Symbol.asyncIterator]: () => ({ next, return: close }) },
        { signal: controller.signal },
      )
      if (!alreadyAborted) controller.abort(reason)
      expect(await prepared.catch((error: unknown) => error)).toBe(reason)
      expect(close).toHaveBeenCalledTimes(1)
      if (alreadyAborted) expect(next).not.toHaveBeenCalled()
    }
  })

  test("propagates transport errors and closes the original iterator", async () => {
    const cause = new Error("upstream disconnected")
    const close = mock(() =>
      Promise.resolve({ done: true as const, value: undefined }),
    )
    const next = mock(() => Promise.reject(cause))
    const prepared = preflightResponseStream({
      [Symbol.asyncIterator]: () => ({ next, return: close }),
    })
    expect(await prepared.catch((error: unknown) => error)).toBe(cause)
    expect(close).toHaveBeenCalledTimes(1)
  })

  test("consumer cancellation and repeated cleanup close the iterator once", async () => {
    const next = mock()
      .mockResolvedValueOnce({ done: false, value: created() })
      .mockResolvedValueOnce({ done: false, value: completed() })
    const close = mock(() =>
      Promise.resolve({ done: true as const, value: undefined }),
    )
    const prepared = await preflightResponseStream({
      [Symbol.asyncIterator]: () => ({ next, return: close }),
    })
    for await (const _chunk of prepared.stream) break
    await prepared.close()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
