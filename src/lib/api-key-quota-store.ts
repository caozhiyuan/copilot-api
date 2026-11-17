import { ApiKeyQuotaLedger, type ApiKeyQuotaBucket } from "./api-key-quota"
import type { SqliteDatabase } from "./sqlite"

export function initializeApiKeyQuotaTables(db: SqliteDatabase): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS api_key_quota_usage (api_key_id TEXT NOT NULL, period TEXT NOT NULL, period_start_ms INTEGER NOT NULL, used_cost_nanos INTEGER NOT NULL, PRIMARY KEY (api_key_id, period, period_start_ms))",
  )
  db.exec(
    "CREATE TABLE IF NOT EXISTS api_key_quota_checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), event_id INTEGER NOT NULL)",
  )
  db.exec(
    "INSERT OR IGNORE INTO api_key_quota_checkpoint (id, event_id) VALUES (1, 0)",
  )
}

function replay(db: SqliteDatabase): {
  ledger: ApiKeyQuotaLedger
  eventId: number
} {
  const ledger = new ApiKeyQuotaLedger()
  ledger.restore(
    db
      .prepare("SELECT * FROM api_key_quota_usage")
      .all() as Array<ApiKeyQuotaBucket>,
  )
  const checkpoint = db
    .prepare("SELECT event_id FROM api_key_quota_checkpoint WHERE id = 1")
    .get() as { event_id: number }
  let eventId = checkpoint.event_id
  const events = db
    .prepare(
      "SELECT id, api_key_id, api_key_cost_nanos, created_at_ms FROM token_usage_events WHERE id > ? ORDER BY id",
    )
    .all(eventId) as Array<{
    id: number
    api_key_id: string | null
    api_key_cost_nanos: number | null
    created_at_ms: number
  }>
  for (const event of events) {
    if (event.api_key_id && event.api_key_cost_nanos !== null)
      ledger.add(
        event.api_key_id,
        event.api_key_cost_nanos,
        event.created_at_ms,
      )
    eventId = event.id
  }
  return { ledger, eventId }
}

export function readApiKeyQuotaLedger(db: SqliteDatabase): ApiKeyQuotaLedger {
  return replay(db).ledger
}

// The checkpoint and totals commit together. Only persisted events are folded
// into this snapshot, so replay after a crash cannot count an event twice.
export function persistApiKeyQuotaLedger(db: SqliteDatabase): void {
  db.exec("BEGIN IMMEDIATE")
  try {
    const { ledger, eventId } = replay(db)
    const upsert = db.prepare(
      "INSERT INTO api_key_quota_usage (api_key_id, period, period_start_ms, used_cost_nanos) VALUES (?, ?, ?, ?) ON CONFLICT(api_key_id, period, period_start_ms) DO UPDATE SET used_cost_nanos = excluded.used_cost_nanos",
    )
    for (const bucket of ledger.snapshot()) {
      upsert.run(
        bucket.api_key_id,
        bucket.period,
        bucket.period_start_ms,
        bucket.used_cost_nanos,
      )
    }
    db.prepare(
      "UPDATE api_key_quota_checkpoint SET event_id = ? WHERE id = 1",
    ).run(eventId)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}
