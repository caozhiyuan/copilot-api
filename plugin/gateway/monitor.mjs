import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Example consumer for in-flight snapshots and monthly timing logs.
export default function setup({ on, server }) {
  const dir = process.env.COPILOT_API_MONITOR_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `inflight-${server.port}-${server.pid}.json`)
  const requests = new Map()
  const flush = () => {
    writeFileSync(`${path}.tmp`, JSON.stringify({
      pid: server.pid,
      port: String(server.port),
      updated: Date.now() / 1000,
      requests: Object.fromEntries(requests),
    }), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }
  flush()
  on("request.start", (event) => {
    requests.set(event.id, {
      t: event.startedAt / 1000,
      model: "unknown",
      user_agent: event.userAgent,
      session_id: event.sessionId,
    })
    flush()
  })
  on("request.model", (event) => {
    const entry = requests.get(event.id)
    if (entry) {
      entry.model = event.model
      flush()
    }
  })
  on("request.session", (event) => {
    const entry = requests.get(event.id)
    if (entry) {
      entry.session_id = event.sessionId
      flush()
    }
  })
  on("request.end", (event) => {
    requests.delete(event.id)
    flush()
    const month = new Date(event.startedAt).toISOString().slice(0, 7)
    appendFileSync(join(dir, `timings-${month}.jsonl`), JSON.stringify({
      t: event.startedAt / 1000,
      port: String(event.port),
      model: event.model ?? "unknown",
      user_agent: event.userAgent,
      session_id: event.sessionId,
      ms: Math.round(event.durationMs),
      first_chunk_ms: event.firstChunkMs === null ? null : Math.round(event.firstChunkMs),
      status: event.status,
      outcome: event.outcome,
    }) + "\n", { mode: 0o600 })
  })
  return () => {
    rmSync(path, { force: true })
    rmSync(`${path}.tmp`, { force: true })
  }
}
