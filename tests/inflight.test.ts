import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Hono } from "hono"

import {
  inflightDir,
  inflightFilePath,
  inflightMiddleware,
} from "~/lib/inflight"
import { createServer } from "~/server"

interface Snapshot {
  pid: number
  port: string
  requests: Record<string, { model: string }>
}

function snapshot(path: string): Snapshot {
  return JSON.parse(readFileSync(path, "utf8")) as Snapshot
}

function useDir(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "inflight-"))
  process.env.COPILOT_API_INFLIGHT_DIR = dir
  return { dir, path: inflightFilePath(dir, "4141") }
}

afterEach(() => delete process.env.COPILOT_API_INFLIGHT_DIR)

describe("in-flight reporter", () => {
  test("publishes zero before the first request", () => {
    const { path } = useDir()
    inflightMiddleware(4141)
    expect(Object.keys(snapshot(path).requests)).toHaveLength(0)
  })

  test("reports a generation request while it runs, then clears it", async () => {
    const { path } = useDir()
    const app = new Hono()
    app.use("*", inflightMiddleware(4141))
    let during: Snapshot | null = null
    app.post("/v1/messages", (c) => {
      during = snapshot(path)
      return c.json({ ok: true })
    })

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-luna" }),
    })

    expect(res.status).toBe(200)
    expect(during!.pid).toBe(process.pid)
    expect(during!.port).toBe("4141")
    const entries = Object.values(during!.requests)
    expect(entries).toHaveLength(1)
    expect(entries[0].model).toBe("gpt-6-luna")
    expect(Object.keys(snapshot(path).requests)).toHaveLength(0)
  })

  test("keeps the entry until a streaming body finishes", async () => {
    const { path } = useDir()
    const app = new Hono()
    app.use("*", inflightMiddleware(4141))
    let release: (() => void) | null = null
    app.post("/v1/responses", () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {}\n\n"))
          release = () => controller.close()
        },
      })
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      })
    })

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-luna" }),
    })
    expect(Object.keys(snapshot(path).requests)).toHaveLength(1)

    const reader = res.body!.getReader()
    await reader.read()
    release!()
    await reader.read()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(Object.keys(snapshot(path).requests)).toHaveLength(0)
  })

  test("ignores non-generation routes", async () => {
    const { path } = useDir()
    const app = new Hono()
    app.use("*", inflightMiddleware(4141))
    app.get("/v1/models", (c) => c.json({ data: [] }))

    await app.request("/v1/models")

    expect(Object.keys(snapshot(path).requests)).toHaveLength(0)
  })

  test("extracts the model from a chunked body without Content-Length", async () => {
    const { path } = useDir()
    const app = new Hono()
    app.use("*", inflightMiddleware(4141))
    let during: Snapshot | null = null
    app.post("/v1/messages", (c) => {
      during = snapshot(path)
      return c.json({ ok: true })
    })

    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"model":"gpt-6-'))
        controller.enqueue(encoder.encode('luna"}'))
        controller.close()
      },
    })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })

    expect(res.status).toBe(200)
    const entries = Object.values(during!.requests)
    expect(entries).toHaveLength(1)
    expect(entries[0].model).toBe("gpt-6-luna")
    expect(Object.keys(snapshot(path).requests)).toHaveLength(0)
  })

  test("caps a chunked body past the limit and leaves the original readable", async () => {
    const { path } = useDir()
    const app = new Hono()
    app.use("*", inflightMiddleware(4141))
    let during: Snapshot | null = null
    let received = 0
    app.post("/v1/messages", async (c) => {
      during = snapshot(path)
      const reader = (c.req.raw.body as ReadableStream<Uint8Array>).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
      }
      return c.json({ ok: true })
    })

    const encoder = new TextEncoder()
    const prefix = '{"model":"gpt-6-luna","padding":"'
    const chunk = "x".repeat(1024 * 1024)
    const suffix = '"}'
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(prefix))
        for (let i = 0; i < 9; i++) controller.enqueue(encoder.encode(chunk))
        controller.enqueue(encoder.encode(suffix))
        controller.close()
      },
    })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })

    expect(res.status).toBe(200)
    // The handler still receives the full original upload even though
    // the reporter stopped reading its clone at the 8 MB cap.
    expect(received).toBe(
      encoder.encode(prefix).byteLength
        + 9 * encoder.encode(chunk).byteLength
        + encoder.encode(suffix).byteLength,
    )
    const entries = Object.values(during!.requests)
    expect(entries).toHaveLength(1)
    expect(entries[0].model).toBe("unknown")
    expect(Object.keys(snapshot(path).requests)).toHaveLength(0)
  })

  test("reports unknown for a tracked POST without a body", async () => {
    const { path } = useDir()
    const app = new Hono()
    app.use("*", inflightMiddleware(4141))
    let during: Snapshot | null = null
    app.post("/v1/messages", (c) => {
      during = snapshot(path)
      return c.json({ ok: true })
    })

    const res = await app.request("/v1/messages", { method: "POST" })

    expect(res.status).toBe(200)
    const entries = Object.values(during!.requests)
    expect(entries).toHaveLength(1)
    expect(entries[0].model).toBe("unknown")
  })

  test("clears the entry when a streaming reader cancels", async () => {
    const { path } = useDir()
    const app = new Hono()
    app.use("*", inflightMiddleware(4141))
    app.post("/v1/responses", () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {}\n\n"))
        },
      })
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      })
    })

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-luna" }),
    })
    expect(Object.keys(snapshot(path).requests)).toHaveLength(1)

    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(Object.keys(snapshot(path).requests)).toHaveLength(0)
  })

  test("clears the entry when a streaming source errors", async () => {
    const { path } = useDir()
    const app = new Hono()
    app.use("*", inflightMiddleware(4141))
    app.post("/v1/responses", () => {
      let sent = false
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) {
            controller.error(new Error("upstream failed"))
            return
          }
          sent = true
          controller.enqueue(new TextEncoder().encode("data: {}\n\n"))
        },
      })
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      })
    })

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-luna" }),
    })
    expect(Object.keys(snapshot(path).requests)).toHaveLength(1)

    const reader = res.body!.getReader()
    await reader.read()
    const error: unknown = await reader.read().then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("upstream failed")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(Object.keys(snapshot(path).requests)).toHaveLength(0)
  })

  test("rejects unauthenticated requests without waiting for the body", async () => {
    const { path } = useDir()
    const app = createServer({ getApiKeys: () => ["test-key"], port: 4141 })
    // A slow upload: one chunk now, the rest 1.5s later. If the reporter
    // ran before auth, it would still be reading the body when the
    // request should already have been rejected with 401.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":"gpt-6-luna"'))
        setTimeout(() => {
          try {
            controller.close()
          } catch {
            // Already cancelled with the rejected request.
          }
        }, 1500)
      },
    })
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })

    const outcome = await Promise.race([
      Promise.resolve(app.request(request)).then((res) => res.status),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timeout"), 1000),
      ),
    ])

    expect(outcome).toBe(401)
    expect(Object.keys(snapshot(path).requests)).toHaveLength(0)
  })

  test("is a no-op when the directory is not configured", async () => {
    delete process.env.COPILOT_API_INFLIGHT_DIR
    expect(inflightDir()).toBeNull()
    const app = new Hono()
    app.use("*", inflightMiddleware(4141))
    app.post("/v1/messages", (c) => c.json({ ok: true }))

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-luna" }),
    })

    expect(res.status).toBe(200)
  })
})
