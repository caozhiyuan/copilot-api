import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Hono } from "hono"

import { requestTimingsMiddleware } from "~/lib/request-timings"
import { zstdDecompressionMiddleware } from "~/lib/zstd-request"

interface TimingLine {
  t: number
  port: string
  model: string
  ms: number
  ttft_ms: number | null
  status: number
}

function lines(dir: string): TimingLine[] {
  const month = new Date().toISOString().slice(0, 7)
  const path = join(dir, `timings-${month}.jsonl`)
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TimingLine)
}

function useDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "timings-"))
  process.env.COPILOT_API_TIMINGS_DIR = dir
  return dir
}

afterEach(() => delete process.env.COPILOT_API_TIMINGS_DIR)

describe("request timings", () => {
  test("records duration, model and port for a normal response", async () => {
    const dir = useDir()
    const app = new Hono()
    app.use("*", requestTimingsMiddleware({ port: 5000 }))
    app.post("/v1/messages", (c) => c.json({ ok: true }))

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "gateway.example.com",
      },
      body: JSON.stringify({ model: "gpt-6-luna" }),
    })
    await res.text() // the body must finish before the record is written

    const [line] = lines(dir)
    expect(line).toBeDefined()
    expect(line.model).toBe("gpt-6-luna")
    expect(line.port).toBe("5000")
    expect(line.status).toBe(200)
    expect(line.ms).toBeGreaterThanOrEqual(0)
    expect(line.ttft_ms).toBeNull()
  })

  test("records time to first chunk only for SSE responses", async () => {
    const dir = useDir()
    const app = new Hono()
    app.use("*", requestTimingsMiddleware())
    app.post("/v1/messages", () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await new Promise((resolve) => setTimeout(resolve, 20))
          controller.enqueue(new TextEncoder().encode("data: {}\n\n"))
          controller.close()
        },
      })
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      })
    })

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-luna" }),
    })
    await res.text()

    const [line] = lines(dir)
    expect(line).toBeDefined()
    expect(line.ttft_ms).not.toBeNull()
    expect(line.ttft_ms!).toBeGreaterThanOrEqual(15)
    expect(line.ms).toBeGreaterThanOrEqual(line.ttft_ms!)
  })

  test("waits for a live JSON body before writing ms", async () => {
    const dir = useDir()
    const app = new Hono()
    app.use("*", requestTimingsMiddleware())
    app.post("/alpha/search", () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await new Promise((resolve) => setTimeout(resolve, 25))
          controller.enqueue(new TextEncoder().encode('{"ok":true}'))
          controller.close()
        },
      })
      return new Response(body, {
        headers: { "content-type": "application/json" },
      })
    })

    const res = await app.request("/alpha/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-luna" }),
    })
    await res.text()

    const [line] = lines(dir)
    expect(line.ms).toBeGreaterThanOrEqual(20)
    expect(line.ttft_ms).toBeNull()
  })

  test("reads the model after zstd decompression on responses routes", async () => {
    const dir = useDir()
    const app = new Hono()
    app.use("/v1/responses", zstdDecompressionMiddleware)
    app.use(
      "/v1/responses",
      requestTimingsMiddleware({ includeResponses: true, port: 5000 }),
    )
    app.post("/v1/responses", (c) => c.json({ ok: true }))

    const compressed = Bun.zstdCompressSync(
      new TextEncoder().encode(JSON.stringify({ model: "gpt-6-luna" })),
    )
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "zstd",
      },
      body: compressed,
    })
    await res.text()

    const [line] = lines(dir)
    expect(line.model).toBe("gpt-6-luna")
    expect(line.port).toBe("5000")
  })

  test("caps model inspection for chunked bodies without content-length", async () => {
    const dir = useDir()
    const app = new Hono()
    app.use("*", requestTimingsMiddleware())
    app.post("/v1/messages", (c) => c.json({ ok: true }))

    const payload = new TextEncoder().encode(
      JSON.stringify({ model: "gpt-6-luna", pad: "x".repeat(9 * 1024 * 1024) }),
    )
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload)
        controller.close()
      },
    })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
    await res.text()

    const [line] = lines(dir)
    expect(line.model).toBe("unknown")
  })

  test("ignores non-generation routes", async () => {
    const dir = useDir()
    const app = new Hono()
    app.use("*", requestTimingsMiddleware())
    app.get("/v1/models", (c) => c.json({ data: [] }))

    await app.request("/v1/models")

    expect(lines(dir)).toHaveLength(0)
  })

  test("is a no-op when the directory is not configured", async () => {
    delete process.env.COPILOT_API_TIMINGS_DIR
    const app = new Hono()
    app.use("*", requestTimingsMiddleware())
    app.post("/v1/messages", (c) => c.json({ ok: true }))

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-luna" }),
    })

    expect(res.status).toBe(200)
  })
})
