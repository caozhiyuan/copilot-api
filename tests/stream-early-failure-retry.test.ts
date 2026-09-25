import { expect, mock, test } from "bun:test"

import { normalizeResponsesApiStreamRetries } from "~/lib/config-store"
import {
  createEarlyFailureRetryStream,
  type ResponsesStreamChunk,
} from "~/routes/responses/stream-early-failure-retry"

const DECRYPT_ERROR =
  "Encrypted function output content could not be decrypted or decoded."

const chunk = (
  type: string,
  fields: Record<string, unknown> = {},
): ResponsesStreamChunk => ({
  data: JSON.stringify({ type, ...fields }),
  event: type,
})

const errorChunk = (message: string, code = "invalid_request_body") =>
  chunk("error", { code, error: { code, message }, message })

async function* streamOf(chunks: Array<ResponsesStreamChunk>) {
  await Promise.resolve()
  for (const item of chunks) {
    yield item
  }
}

const successfulAttempt = () =>
  streamOf([
    chunk("response.created"),
    chunk("response.in_progress"),
    chunk("response.output_text.delta", { delta: "OK" }),
    chunk("response.completed"),
  ])

const collectTypes = async (
  stream: AsyncIterable<ResponsesStreamChunk>,
): Promise<Array<string | undefined>> => {
  const types: Array<string | undefined> = []
  for await (const item of stream) {
    types.push(item.event)
  }
  return types
}

test("passes a successful stream through in order", async () => {
  const retry = mock(() => Promise.resolve(successfulAttempt()))

  const types = await collectTypes(
    createEarlyFailureRetryStream(successfulAttempt(), {
      maxRetries: 2,
      retry,
    }),
  )

  expect(types).toEqual([
    "response.created",
    "response.in_progress",
    "response.output_text.delta",
    "response.completed",
  ])
  expect(retry).not.toHaveBeenCalled()
})

test("retries a decryption failure that happens before any output", async () => {
  const retry = mock(() => Promise.resolve(successfulAttempt()))
  const onRetry = mock((_attempt: number, _reason: string) => {})

  const types = await collectTypes(
    createEarlyFailureRetryStream(
      streamOf([chunk("response.created"), errorChunk(DECRYPT_ERROR)]),
      { maxRetries: 2, onRetry, retry },
    ),
  )

  expect(types).toEqual([
    "response.created",
    "response.in_progress",
    "response.output_text.delta",
    "response.completed",
  ])
  expect(retry).toHaveBeenCalledTimes(1)
  expect(onRetry).toHaveBeenCalledWith(1, DECRYPT_ERROR)
})

test("retries response.failed without error details and internal server errors", async () => {
  const attempts = [
    streamOf([chunk("response.created"), errorChunk("internal server error")]),
    successfulAttempt(),
  ]
  const retry = mock(() => Promise.resolve(attempts.shift() ?? streamOf([])))

  const types = await collectTypes(
    createEarlyFailureRetryStream(
      streamOf([
        chunk("response.created"),
        chunk("response.failed", { response: { error: null } }),
      ]),
      { maxRetries: 3, retry },
    ),
  )

  expect(types.at(-1)).toBe("response.completed")
  expect(retry).toHaveBeenCalledTimes(2)
})

test("does not retry errors that are not transient", async () => {
  const retry = mock(() => Promise.resolve(successfulAttempt()))

  const types = await collectTypes(
    createEarlyFailureRetryStream(
      streamOf([
        chunk("response.created"),
        errorChunk("This content was flagged", "cyber_policy"),
      ]),
      { maxRetries: 2, retry },
    ),
  )

  expect(types).toEqual(["response.created", "error"])
  expect(retry).not.toHaveBeenCalled()
})

test("does not retry connection failures reported as error chunks", async () => {
  const retry = mock(() => Promise.resolve(successfulAttempt()))

  const types = await collectTypes(
    createEarlyFailureRetryStream(
      streamOf([
        errorChunk(
          "Failed to create responses websocket: Expected 101 status code",
        ),
      ]),
      { maxRetries: 2, retry },
    ),
  )

  expect(types).toEqual(["error"])
  expect(retry).not.toHaveBeenCalled()
})

test("does not retry a failure after output has started", async () => {
  const retry = mock(() => Promise.resolve(successfulAttempt()))

  const types = await collectTypes(
    createEarlyFailureRetryStream(
      streamOf([
        chunk("response.created"),
        chunk("response.output_text.delta", { delta: "partial" }),
        errorChunk(DECRYPT_ERROR),
      ]),
      { maxRetries: 2, retry },
    ),
  )

  expect(types).toEqual([
    "response.created",
    "response.output_text.delta",
    "error",
  ])
  expect(retry).not.toHaveBeenCalled()
})

test("surfaces the last failure once retries are exhausted", async () => {
  const retry = mock(() =>
    Promise.resolve(
      streamOf([chunk("response.created"), errorChunk(DECRYPT_ERROR)]),
    ),
  )

  const types = await collectTypes(
    createEarlyFailureRetryStream(
      streamOf([chunk("response.created"), errorChunk(DECRYPT_ERROR)]),
      { maxRetries: 2, retry },
    ),
  )

  expect(types).toEqual(["response.created", "error"])
  expect(retry).toHaveBeenCalledTimes(2)
})

test("surfaces the original failure when a retry cannot be started", async () => {
  const retry = mock(() => Promise.reject(new Error("upstream unavailable")))

  const types = await collectTypes(
    createEarlyFailureRetryStream(
      streamOf([chunk("response.created"), errorChunk(DECRYPT_ERROR)]),
      { maxRetries: 2, retry },
    ),
  )

  expect(types).toEqual(["response.created", "error"])
  expect(retry).toHaveBeenCalledTimes(1)
})

test("normalizes the configured retry count", () => {
  expect(normalizeResponsesApiStreamRetries(undefined)).toBe(0)
  expect(normalizeResponsesApiStreamRetries("3")).toBe(0)
  expect(normalizeResponsesApiStreamRetries(Number.NaN)).toBe(0)
  expect(normalizeResponsesApiStreamRetries(-2)).toBe(0)
  expect(normalizeResponsesApiStreamRetries(2.7)).toBe(2)
  expect(normalizeResponsesApiStreamRetries(4)).toBe(4)
  expect(normalizeResponsesApiStreamRetries(99)).toBe(10)
})

test("retries response.failed only when its error is transient", async () => {
  const retry = mock(() => Promise.resolve(successfulAttempt()))
  const failedWith = (message: string) =>
    streamOf([
      chunk("response.created"),
      chunk("response.failed", {
        response: { error: { code: "server_error", message } },
      }),
    ])

  const retried = await collectTypes(
    createEarlyFailureRetryStream(failedWith("internal server error"), {
      maxRetries: 1,
      retry,
    }),
  )
  const notRetried = await collectTypes(
    createEarlyFailureRetryStream(failedWith("context length exceeded"), {
      maxRetries: 1,
      retry,
    }),
  )

  expect(retried.at(-1)).toBe("response.completed")
  expect(notRetried).toEqual(["response.created", "response.failed"])
  expect(retry).toHaveBeenCalledTimes(1)
})
