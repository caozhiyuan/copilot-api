import { randomUUID } from "node:crypto"
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Context, MiddlewareHandler } from "hono"

// Opt-in in-flight request reporter for external usage monitors.
//
// Set COPILOT_API_INFLIGHT_DIR to a directory to publish one
// inflight-<port>-<pid>.json snapshot per process:
//
//   {"pid": 1234, "port": "4141", "updated": 1760000000,
//    "requests": {"<id>": {"t": 1760000000, "model": "<request model>"}}}
//
// Contract:
// - one file per process, so a reader can liveness-check `pid` with
//   kill(pid, 0) and ignore snapshots left by a crash
// - `updated` and `t` are epoch seconds (POSIX time)
// - write to a temp file then rename: readers never see a partial document
// - mode 0600, removed on exit, entries older than STALE_S ignored
// - any OpenAI-compatible gateway can emit the same contract, so one monitor
//   reads them all; nothing here depends on a specific collector
// Unset -> the middleware only calls next(), so nothing is written.
const ENV_DIR = "COPILOT_API_INFLIGHT_DIR"
const STALE_S = 900
const MAX_BODY_BYTES = 8 * 1024 * 1024
const TRACKED = /\/(chat\/completions|responses|messages|alpha\/search)$/

interface Entry {
  t: number
  model: string
}

export function inflightDir(): string | null {
  const dir = process.env[ENV_DIR]?.trim()
  return dir ? dir : null
}

export function inflightFilePath(dir: string, port: string | number): string {
  return join(dir, `inflight-${port}-${process.pid}.json`)
}

// Read the cloned body with a hard byte cap. Content-Length alone cannot
// enforce the limit: chunked uploads omit it, and clone().json() would
// buffer the entire payload. Returns null when the cap is exceeded.
async function readCappedClone(c: Context): Promise<string | null> {
  const body = c.req.raw.clone().body
  if (!body) return null
  const reader = (body as ReadableStream<Uint8Array>).getReader()
  const chunks: Array<Uint8Array> = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) {
        // Stop consuming the clone, but never await its cancellation:
        // the handler must stay free to read the original request body.
        void reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

async function readModel(c: Context): Promise<string> {
  const length = Number(c.req.header("content-length") ?? 0)
  // Image payloads can be large; cloning them just to read one field is waste.
  if (length > MAX_BODY_BYTES) return "unknown"
  try {
    const text = await readCappedClone(c)
    if (text === null) return "unknown"
    const body = JSON.parse(text) as { model?: unknown }
    return typeof body?.model === "string" && body.model ?
        body.model
      : "unknown"
  } catch {
    return "unknown"
  }
}

export function inflightMiddleware(
  port: string | number = process.env.PORT ?? 4141,
): MiddlewareHandler {
  const dir = inflightDir()
  if (!dir) return async (_c, next) => await next()

  const path = inflightFilePath(dir, port)
  const active = new Map<string, Entry>()

  const flush = (): void => {
    const now = Date.now() / 1000
    for (const [id, entry] of active) {
      if (now - entry.t > STALE_S) active.delete(id)
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const tmp = `${path}.tmp`
      writeFileSync(
        tmp,
        JSON.stringify({
          pid: process.pid,
          port: String(port),
          updated: now,
          requests: Object.fromEntries(active),
        }),
        { mode: 0o600 },
      )
      renameSync(tmp, path)
    } catch {
      // Reporting must never break a request.
    }
  }

  const remove = (): void => {
    try {
      unlinkSync(path)
    } catch {
      // Already gone.
    }
  }

  process.once("exit", remove)
  flush() // publish "0 in flight" before the first request

  return async (c, next) => {
    if (c.req.method !== "POST" || !TRACKED.test(new URL(c.req.url).pathname)) {
      await next()
      return
    }

    const id = randomUUID()
    active.set(id, { t: Date.now() / 1000, model: await readModel(c) })
    flush()

    const done = (): void => {
      if (active.delete(id)) flush()
    }

    try {
      await next()
      const res = c.res
      const streaming =
        res?.body
        && (res.headers.get("content-type") ?? "").includes("text/event-stream")
      if (streaming && res) {
        // Keep the entry until the stream terminates, not when headers
        // arrive. TransformStream.flush only runs on a clean close, so
        // also observe the pipe itself: a reader cancellation or a
        // source error settles it without ever invoking flush, and this
        // middleware has already returned by then.
        const transform = new TransformStream<Uint8Array, Uint8Array>({
          flush: done,
        })
        void res.body.pipeTo(transform.writable).then(done, done)
        c.res = new Response(transform.readable, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        })
        return
      }
      done()
    } catch (error) {
      done()
      throw error
    }
  }
}
