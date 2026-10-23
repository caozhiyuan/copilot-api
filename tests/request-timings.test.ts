import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Hono } from "hono"

import { requestTimingsMiddleware } from "~/lib/request-timings"

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
    app.use("*", requestTimingsMiddleware())
    app.post("/v1/messages", (c) => c.json({ ok: true }))

    await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", host: "127.0.0.1:4141" },
      body: JSON.stringify({ model: "gpt-6-luna" }),
    })

    const [line] = lines(dir)
    expect(line).toBeDefined()
    expect(line.model).toBe("gpt-6-luna")
    expect(line.port).toBe("4141")
    expect(line.status).toBe(200)
    expect(line.ms).toBeGreaterThanOrEqual(0)
    expect(line.ttft_ms).toBeNull()
  })

  test("records time to first chunk for a streamed response", async () => {
    const dir = useDir()
    const app = new Hono()
    app.use("*", requestTimingsMiddleware())
    app.post("/v1/responses", () => {
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

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", host: "127.0.0.1:4141" },
      body: JSON.stringify({ model: "gpt-6-luna" }),
    })
    await res.text()

    const [line] = lines(dir)
    expect(line).toBeDefined()
    expect(line.ttft_ms).not.toBeNull()
    expect(line.ttft_ms!).toBeGreaterThanOrEqual(15)
    expect(line.ms).toBeGreaterThanOrEqual(line.ttft_ms!)
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
