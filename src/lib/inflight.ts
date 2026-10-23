import { randomUUID } from "node:crypto"
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Context, MiddlewareHandler } from "hono"

// Opt-in in-flight request reporter for external usage monitors.
//
// Set COPILOT_API_INFLIGHT_DIR to a directory to publish
// inflight-<port>-<pid>.json there: one entry per active generation request,
// rewritten atomically with mode 0600 and removed on exit. The file shape
// matches litellm_usage_log.py so one monitor can read every gateway:
// {pid, port, updated, requests: {<id>: {t, model}}} with seconds timestamps.
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

async function readModel(c: Context): Promise<string> {
  const length = Number(c.req.header("content-length") ?? 0)
  // Image payloads can be large; cloning them just to read one field is waste.
  if (length > MAX_BODY_BYTES) return "unknown"
  try {
    const body = (await c.req.raw.clone().json()) as { model?: unknown }
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
        // Keep the entry until the stream ends, not when headers arrive.
        const body = res.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({ flush: done }),
        )
        c.res = new Response(body, {
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
