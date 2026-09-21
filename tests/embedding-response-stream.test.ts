import { describe, expect, mock, test } from "bun:test"

import { streamEmbeddingResponseBody } from "~/lib/embedding-response-stream"
import { UpstreamResponseSizeLimitExceededError } from "~/lib/error"

const encoder = new TextEncoder()

describe("streamEmbeddingResponseBody", () => {
  test("streams exact chunks while extracting root usage", async () => {
    const responseText =
      '{"data":[{"metadata":{"usage":{"prompt_tokens":999}},"embedding":[0.1]}],"us\\u0061ge":{"total_tokens":42,"prompt_tok\\u0065ns":42}}'
    const responseBytes = encoder.encode(responseText)
    const chunks = Array.from(responseBytes, (byte) => new Uint8Array([byte]))
    const onPromptTokens = mock((_promptTokens: number) => {})
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })

    const streamedBody = streamEmbeddingResponseBody(
      source,
      responseBytes.byteLength,
      onPromptTokens,
    )

    expect(await new Response(streamedBody).text()).toBe(responseText)
    expect(onPromptTokens).toHaveBeenCalledTimes(1)
    expect(onPromptTokens).toHaveBeenCalledWith(42)
  })

  test("delivers chunks before the upstream response completes", async () => {
    let sourceController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController = controller
        controller.enqueue(encoder.encode('{"data":['))
      },
    })
    const onPromptTokens = mock((_promptTokens: number) => {})
    const reader = streamEmbeddingResponseBody(
      source,
      1024,
      onPromptTokens,
    ).getReader()

    const firstChunk = await reader.read()
    expect(new TextDecoder().decode(firstChunk.value)).toBe('{"data":[')
    expect(firstChunk.done).toBe(false)

    sourceController?.enqueue(
      encoder.encode('],"usage":{"prompt_tokens":7,"total_tokens":7}}'),
    )
    sourceController?.close()
    expect((await reader.read()).done).toBe(false)
    expect((await reader.read()).done).toBe(true)
    expect(onPromptTokens).toHaveBeenCalledWith(7)
  })

  test("cancels streams that exceed the byte limit", async () => {
    let cancelReason: unknown
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("123"))
        controller.enqueue(encoder.encode("4"))
      },
      cancel(reason) {
        cancelReason = reason
      },
    })
    const reader = streamEmbeddingResponseBody(source, 3, () => {}).getReader()

    expect(new TextDecoder().decode((await reader.read()).value)).toBe("123")
    let thrown: unknown
    try {
      await reader.read()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(UpstreamResponseSizeLimitExceededError)
    await Promise.resolve()
    expect(cancelReason).toBeInstanceOf(UpstreamResponseSizeLimitExceededError)
  })
})
