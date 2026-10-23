import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

import type { Context, MiddlewareHandler } from "hono"

// Opt-in per-request timing log for external usage monitors.
//
// Set COPILOT_API_TIMINGS_DIR to a directory and each completed generation
// request appends one JSON line:
//
//   {"t": 1760000000, "port": "4141", "model": "<request model>",
//    "ms": 1234, "ttft_ms": 456, "status": 200}
//
// `t` is epoch seconds, `ttft_ms` is when the first response body chunk
// arrived (null for non-streaming answers), and the field names match the
// LiteLLM usage callback so one monitor can read every gateway. Unset env
// means the middleware only calls next().
const ENV_DIR = "COPILOT_API_TIMINGS_DIR"
const MAX_BODY_BYTES = 8 * 1024 * 1024
const TRACKED = /\/(chat\/completions|responses|messages|alpha\/search)$/

interface TimingRecord {
  t: number
  port: string
  model: string
  ms: number
  ttft_ms: number | null
  status: number
}

export function timingsDir(): string | null {
  const dir = process.env[ENV_DIR]?.trim()
  return dir ? dir : null
}

async function readModel(c: Context): Promise<string> {
  const length = Number(c.req.header("content-length") ?? 0)
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

function appendTiming(dir: string, record: TimingRecord): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const month = new Date(record.t * 1000).toISOString().slice(0, 7)
    appendFileSync(
      join(dir, `timings-${month}.jsonl`),
      JSON.stringify(record) + "\n",
      {
        mode: 0o600,
      },
    )
  } catch {
    // Telemetry must never break a request.
  }
}

export function requestTimingsMiddleware(): MiddlewareHandler {
  const dir = timingsDir()
  if (!dir) return async (_c, next) => await next()

  return async (c, next) => {
    if (c.req.method !== "POST" || !TRACKED.test(new URL(c.req.url).pathname)) {
      await next()
      return
    }

    const started = performance.now()
    const model = await readModel(c)
    await next()

    const res = c.res
    let ttftMs: number | null = null
    let recorded = false
    const record = (): void => {
      if (recorded) return
      recorded = true
      const host = c.req.header("host") ?? ""
      const port = host.match(/:(\d+)$/)?.[1] ?? process.env.PORT ?? "4141"
      appendTiming(dir, {
        t: Date.now() / 1000,
        port,
        model,
        ms: Math.round(performance.now() - started),
        ttft_ms: ttftMs === null ? null : Math.round(ttftMs),
        status: res?.status ?? 0,
      })
    }

    const streaming =
      res?.body
      && (res.headers.get("content-type") ?? "").includes("text/event-stream")
    if (streaming && res) {
      let first = true
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (first) {
            first = false
            ttftMs = performance.now() - started
          }
          controller.enqueue(chunk)
        },
        flush: record,
      })
      void res.body.pipeTo(transform.writable).then(record, record)
      c.res = new Response(transform.readable, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
      return
    }

    record()
  }
}
