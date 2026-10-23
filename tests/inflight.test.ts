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
