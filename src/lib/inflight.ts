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
// - mode 0600, removed on exit
// - a request stays listed until it completes, fails, or is cancelled; the
//   reporter never prunes by age, so long streams do not disappear
// - the model is supplied by the handler after it parses the request, so the
//   reporter never reads or parses the body a second time
// - any OpenAI-compatible gateway can emit the same contract, so one monitor
//   reads them all; nothing here depends on a specific collector
// Unset -> the middleware only calls next(), so nothing is written.
const ENV_DIR = "COPILOT_API_INFLIGHT_DIR"
const TRACKED = /\/(chat\/completions|responses|messages|alpha\/search)$/

interface Entry {
  t: number
  model: string
}

// The middleware and the route handler share the same Context instance.
const modelSetters = new WeakMap<object, (model: string) => void>()

export function inflightDir(): string | null {
  const dir = process.env[ENV_DIR]?.trim()
  return dir ? dir : null
}

export function inflightFilePath(dir: string, port: string | number): string {
  return join(dir, `inflight-${port}-${process.pid}.json`)
}

/**
 * Handlers call this right after parsing the request body. Reusing their parse
 * avoids a second body read, and works for decompressed bodies too.
 */
export function markInflightModel(
  c: Context,
  model: string | undefined | null,
): void {
  if (typeof model === "string" && model) modelSetters.get(c)?.(model)
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
    const entry: Entry = { t: Date.now() / 1000, model: "unknown" }
    active.set(id, entry)
    modelSetters.set(c, (model) => {
      entry.model = model
      flush()
    })
    flush()

    const done = (): void => {
      modelSetters.delete(c)
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
