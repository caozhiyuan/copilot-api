import { describe, expect, test } from "bun:test"
import type { SSEStreamingApi } from "hono/streaming"

import {
  forEachWithIdleKeepalive,
  writeRawSSEIfConnected,
  writeSSEIfConnected,
} from "~/lib/http/sse"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function createMockStream(options?: {
  aborted?: boolean
  closed?: boolean
  onWrite?: (chunk: string) => Promise<void> | void
  onWriteSSE?: () => Promise<void> | void
}) {
  const written: Array<string> = []
  const stream = {
    aborted: options?.aborted ?? false,
    closed: options?.closed ?? false,
    write: async (chunk: string) => {
      await options?.onWrite?.(chunk)
      written.push(chunk)
      return stream
    },
    writeSSE: async () => {
      await options?.onWriteSSE?.()
    },
  } as unknown as SSEStreamingApi

  return { stream, written }
}

describe("SSE helpers", () => {
  test("writeRawSSEIfConnected writes only while stream is open and connected", async () => {
    const { stream, written } = createMockStream()
    expect(await writeRawSSEIfConnected(stream, "\n\n")).toBe(true)
    expect(written).toEqual(["\n\n"])

    const aborted = createMockStream({ aborted: true })
    expect(await writeRawSSEIfConnected(aborted.stream, "\n\n")).toBe(false)
    expect(aborted.written).toEqual([])

    const closed = createMockStream({ closed: true })
    expect(await writeRawSSEIfConnected(closed.stream, "\n\n")).toBe(false)
    expect(closed.written).toEqual([])

    const closesDuringWrite = createMockStream({
      onWrite: () => {
        closesDuringWrite.stream.closed = true
      },
    })
    expect(await writeRawSSEIfConnected(closesDuringWrite.stream, "\n\n")).toBe(
      false,
    )

    const throwsWhileAborted = createMockStream({
      onWrite: () => {
        throwsWhileAborted.stream.aborted = true
        throw new Error("socket closed")
      },
    })
    expect(
      await writeRawSSEIfConnected(throwsWhileAborted.stream, "\n\n"),
    ).toBe(false)

    const throwsWhileConnected = createMockStream({
      onWrite: () => {
        throw new Error("unexpected write failure")
      },
    })
    let writeError: unknown
    try {
      await writeRawSSEIfConnected(throwsWhileConnected.stream, "\n\n")
    } catch (error) {
      writeError = error
    }
    expect(writeError).toBeInstanceOf(Error)
    expect((writeError as Error).message).toBe("unexpected write failure")
  })

  test("writeSSEIfConnected respects aborted state", async () => {
    const { stream } = createMockStream()
    expect(await writeSSEIfConnected(stream, { data: "ok" })).toBe(true)

    const aborted = createMockStream({ aborted: true })
    expect(await writeSSEIfConnected(aborted.stream, { data: "skip" })).toBe(
      false,
    )
  })

  test("forEachWithIdleKeepalive emits keepalives before first chunk and during pauses without dropping chunks", async () => {
    const events: Array<string> = []
    async function* slowSource(): AsyncGenerator<string> {
      await sleep(55)
      yield "first"
      await sleep(55)
      yield "second"
    }

    const controller = new AbortController()
    await forEachWithIdleKeepalive(slowSource(), {
      intervalMs: 20,
      signal: controller.signal,
      onChunk: (chunk) => {
        events.push(`chunk:${chunk}`)
        return Promise.resolve(true)
      },
      onKeepalive: () => {
        events.push("keepalive")
        return Promise.resolve(true)
      },
    })

    const firstIndex = events.indexOf("chunk:first")
    const secondIndex = events.indexOf("chunk:second")
    expect(firstIndex).toBeGreaterThan(0)
    expect(secondIndex).toBeGreaterThan(firstIndex + 1)
    expect(events.slice(0, firstIndex).every((e) => e === "keepalive")).toBe(
      true,
    )
    expect(
      events.slice(firstIndex + 1, secondIndex).every((e) => e === "keepalive"),
    ).toBe(true)
  })

  test("forEachWithIdleKeepalive disables keepalive when intervalMs <= 0", async () => {
    const chunks: Array<string> = []
    let keepalives = 0
    async function* source(): AsyncGenerator<string> {
      await sleep(25)
      yield "only"
    }

    await forEachWithIdleKeepalive(source(), {
      intervalMs: 0,
      signal: new AbortController().signal,
      onChunk: (chunk) => {
        chunks.push(chunk)
        return Promise.resolve(true)
      },
      onKeepalive: () => {
        keepalives += 1
        return Promise.resolve(true)
      },
    })

    expect(chunks).toEqual(["only"])
    expect(keepalives).toBe(0)
  })

  test("forEachWithIdleKeepalive stops cleanly on abort, disconnect, and upstream error", async () => {
    // 1. Pre-aborted signal returns without iterating
    let started = false
    const preAborted = new AbortController()
    preAborted.abort()
    async function* neverStarted(): AsyncGenerator<string> {
      started = true
      await Promise.resolve()
      yield "never"
    }
    await forEachWithIdleKeepalive(neverStarted(), {
      intervalMs: 10,
      signal: preAborted.signal,
      onChunk: () => Promise.resolve(true),
      onKeepalive: () => Promise.resolve(true),
    })
    expect(started).toBe(false)

    // 2. Abort mid-wait (during waitForStep) cancels cleanly without unhandled rejection
    const midAbort = new AbortController()
    let returned = false
    const pendingSource: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<string>>((_, reject) => {
              midAbort.signal.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              )
            }),
          return: () => {
            returned = true
            return Promise.resolve({ done: true, value: undefined })
          },
        }
      },
    }
    let midKeepalives = 0
    setTimeout(() => midAbort.abort(), 35)
    await forEachWithIdleKeepalive(pendingSource, {
      intervalMs: 15,
      signal: midAbort.signal,
      onChunk: () => Promise.resolve(true),
      onKeepalive: () => {
        midKeepalives += 1
        return Promise.resolve(true)
      },
    })
    expect(midKeepalives).toBeGreaterThanOrEqual(1)
    expect(returned).toBe(true)

    // 3. Stops when onKeepalive or onChunk signals disconnect (false)
    let disconnectKeepalives = 0
    async function* stallingSource(): AsyncGenerator<string> {
      await sleep(200)
      yield "late"
    }
    await forEachWithIdleKeepalive(stallingSource(), {
      intervalMs: 15,
      signal: new AbortController().signal,
      onChunk: () => Promise.resolve(true),
      onKeepalive: () => {
        disconnectKeepalives += 1
        return Promise.resolve(false)
      },
    })
    expect(disconnectKeepalives).toBe(1)

    const received: Array<string> = []
    async function* multiSource(): AsyncGenerator<string> {
      await Promise.resolve()
      yield "a"
      yield "b"
    }
    await forEachWithIdleKeepalive(multiSource(), {
      intervalMs: 15,
      signal: new AbortController().signal,
      onChunk: (chunk) => {
        received.push(chunk)
        return Promise.resolve(false)
      },
      onKeepalive: () => Promise.resolve(true),
    })
    expect(received).toEqual(["a"])

    // 4. Upstream error propagates to caller
    async function* failingSource(): AsyncGenerator<string> {
      await sleep(10)
      yield "ok"
      throw new Error("upstream boom")
    }
    let caught: unknown
    try {
      await forEachWithIdleKeepalive(failingSource(), {
        intervalMs: 50,
        signal: new AbortController().signal,
        onChunk: () => Promise.resolve(true),
        onKeepalive: () => Promise.resolve(true),
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe("upstream boom")
  })
})
