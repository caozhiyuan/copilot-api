import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const FLUSH_DELAY_MS = 50
const MAX_RETRY_DELAY_MS = 5_000

// Example consumer for in-flight snapshots and monthly timing logs.
export default async function setup({ log, on, server }) {
  const dir = process.env.COPILOT_API_MONITOR_DIR
  if (!dir) return
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `inflight-${server.port}-${server.pid}.json`)
  const requests = new Map()
  let dirty = false
  let timer
  let pendingWrite
  let retryDelay = FLUSH_DELAY_MS
  let closing = false

  const flush = () => {
    if (pendingWrite || closing || !dirty) return pendingWrite
    dirty = false
    const payload = JSON.stringify({
      pid: server.pid,
      port: String(server.port),
      updated: Date.now() / 1000,
      requests: Object.fromEntries(requests),
    })
    pendingWrite = (async () => {
      try {
        await writeFile(`${path}.tmp`, payload, { mode: 0o600 })
        await rename(`${path}.tmp`, path)
        retryDelay = FLUSH_DELAY_MS
      } catch (error) {
        dirty = true
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS)
        log(`Failed to write inflight snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`)
      }
    })().finally(() => {
      pendingWrite = undefined
      if (dirty) scheduleFlush(retryDelay)
    })
    return pendingWrite
  }

  const scheduleFlush = (delay = FLUSH_DELAY_MS) => {
    dirty = true
    // Keep only the latest state while the single writer is busy.
    if (timer || pendingWrite || closing) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, delay)
    timer.unref?.()
  }

  dirty = true
  await flush()
  on("request.start", (event) => {
    requests.set(event.id, {
      t: event.startedAt / 1000,
      model: "unknown",
      actual_model: event.actualModel,
      user_agent: event.userAgent,
      session_id: event.sessionId,
      ttft_ms: null,
    })
    scheduleFlush()
  })
  on("request.model", (event) => {
    const entry = requests.get(event.id)
    if (entry) {
      entry.model = event.model
      scheduleFlush()
    }
  })
  on("request.actual_model", (event) => {
    const entry = requests.get(event.id)
    if (entry) {
      entry.actual_model = event.actualModel
      scheduleFlush()
    }
  })
  on("request.session", (event) => {
    const entry = requests.get(event.id)
    if (entry) {
      entry.session_id = event.sessionId
      scheduleFlush()
    }
  })
  on("request.first_token", (event) => {
    const entry = requests.get(event.id)
    if (entry) {
      entry.ttft_ms = Math.round(event.firstTokenMs)
      scheduleFlush()
    }
  })
  on("request.end", async (event) => {
    requests.delete(event.id)
    scheduleFlush()
    const month = new Date(event.startedAt).toISOString().slice(0, 7)
    await appendFile(join(dir, `timings-${month}.jsonl`), JSON.stringify({
      t: event.startedAt / 1000,
      port: String(event.port),
      model: event.model ?? "unknown",
      actual_model: event.actualModel,
      user_agent: event.userAgent,
      session_id: event.sessionId,
      ms: Math.round(event.durationMs),
      ttft_ms: event.firstTokenMs === null ? null : Math.round(event.firstTokenMs),
      status: event.status,
      outcome: event.outcome,
    }) + "\n", { mode: 0o600 })
  })
  return async () => {
    closing = true
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    await pendingWrite
    await rm(path, { force: true })
    await rm(`${path}.tmp`, { force: true })
  }
}
