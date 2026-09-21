import { describe, expect, test } from "bun:test"

import {
  BodySizeLimitExceededError,
  readBodyWithLimit,
} from "~/lib/bounded-body"

describe("readBodyWithLimit", () => {
  test("combines chunks within the limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3]))
        controller.close()
      },
    })

    expect(await readBodyWithLimit(body, 3)).toEqual(new Uint8Array([1, 2, 3]))
  })

  test("cancels a stream as soon as its body exceeds the limit", async () => {
    let cancelReason: unknown
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3, 4]))
      },
      cancel(reason) {
        cancelReason = reason
      },
    })

    let thrown: unknown
    try {
      await readBodyWithLimit(body, 3)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(BodySizeLimitExceededError)
    await Promise.resolve()
    expect(cancelReason).toBeInstanceOf(BodySizeLimitExceededError)
  })

  test("rejects an oversized content length without reading", async () => {
    let pulled = false
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulled = true
      },
    })

    let thrown: unknown
    try {
      await readBodyWithLimit(body, 3, "4")
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(BodySizeLimitExceededError)
    expect(pulled).toBe(false)
  })
})
