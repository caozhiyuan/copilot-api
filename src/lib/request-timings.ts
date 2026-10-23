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
// `t` is epoch seconds, `ttft_ms` is when the first streamed chunk arrived
// (null unless the response is SSE), and `ms` is measured when the response
// body finishes. Field names match the LiteLLM usage callback so one monitor
// can read every gateway. Unset env means the middleware only calls next().
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

export interface RequestTimingsOptions {
  /**
   * Responses routes register this after their zstd middleware, so the model
   * is read from the decompressed body. The global registration skips them.
   */
  includeResponses?: boolean
  /** Actual listener port; avoids trusting a client-supplied Host header. */
  port?: number
}

export function timingsDir(): string | null {
  const dir = process.env[ENV_DIR]?.trim()
  return dir ? dir : null
}

// Content-Length is absent for chunked uploads, so read the clone with a hard
// byte cap instead of letting json() buffer the whole payload.
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
        // Never await cancellation: the handler still needs the original body.
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
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return "unknown"
  const text = await readCappedClone(c)
  if (text === null) return "unknown"
  try {
    const body = JSON.parse(text) as { model?: unknown }
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

export function requestTimingsMiddleware(
  options: RequestTimingsOptions = {},
): MiddlewareHandler {
  const dir = timingsDir()
  if (!dir) return async (_c, next) => await next()
  const port = String(options.port ?? process.env.PORT ?? 4141)
  const responsesHere = options.includeResponses ?? false

  return async (c, next) => {
    const pathname = new URL(c.req.url).pathname
    if (
      c.req.method !== "POST"
      || !TRACKED.test(pathname)
      || /\/responses$/.test(pathname) !== responsesHere
    ) {
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
      appendTiming(dir, {
        t: Date.now() / 1000,
        port,
        model,
        ms: Math.round(performance.now() - started),
        ttft_ms: ttftMs === null ? null : Math.round(ttftMs),
        status: res?.status ?? 0,
      })
    }

    // Every body is wrapped so `ms` ends when the response actually completes,
    // not when the handler returns. TTFT only applies to SSE streams.
    if (res?.body) {
      const sse = (res.headers.get("content-type") ?? "").includes(
        "text/event-stream",
      )
      let first = true
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (sse && first) {
            first = false
            ttftMs = performance.now() - started
          }
          controller.enqueue(chunk)
        },
        flush: record,
      })
      void res.body.pipeTo(transform.writable).then(record, record)
      const headers = new Headers(res.headers)
      headers.delete("content-length") // streamed through a transform
      c.res = new Response(transform.readable, {
        status: res.status,
        statusText: res.statusText,
        headers,
      })
      return
    }

    record()
  }
}
