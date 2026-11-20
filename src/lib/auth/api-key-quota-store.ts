import { ApiKeyQuotaLedger, type ApiKeyQuotaBucket } from "./api-key-quota"
import type { SqliteDatabase } from "../storage/sqlite"

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

function readCheckpoint(db: SqliteDatabase): number {
  const row = db
    .prepare<{
      event_id: number
    }>("SELECT event_id FROM api_key_quota_checkpoint WHERE id = 1")
    .get()
  if (!row) throw new Error("API key quota checkpoint is missing")
  return row.event_id
}

function addPendingCharges(
  db: SqliteDatabase,
  ledger: ApiKeyQuotaLedger,
  checkpoint: number,
): void {
  const events = db
    .prepare<{
      api_key_id: string
      api_key_cost_nanos: number
      created_at_ms: number
    }>(
      "SELECT api_key_id, api_key_cost_nanos, created_at_ms FROM token_usage_events WHERE id > ? AND api_key_id <> '' AND api_key_cost_nanos IS NOT NULL ORDER BY id",
    )
    .all(checkpoint)
  for (const event of events) {
    ledger.add(event.api_key_id, event.api_key_cost_nanos, event.created_at_ms)
  }
}

export function readApiKeyQuotaLedger(db: SqliteDatabase): ApiKeyQuotaLedger {
  const ledger = new ApiKeyQuotaLedger()
  ledger.restore(
    db.prepare<ApiKeyQuotaBucket>("SELECT * FROM api_key_quota_usage").all(),
  )
  addPendingCharges(db, ledger, readCheckpoint(db))
  return ledger
}

// Advance the checkpoint in the same transaction as the changed buckets.
export function persistApiKeyQuotaLedger(db: SqliteDatabase): void {
  const readLastEventId = () =>
    db
      .prepare<{
        id: number | null
      }>("SELECT MAX(id) AS id FROM token_usage_events")
      .get()?.id ?? 0
  if (readLastEventId() <= readCheckpoint(db)) return

  db.exec("BEGIN IMMEDIATE")
  try {
    const checkpoint = readCheckpoint(db)
    const eventId = readLastEventId()
    if (eventId > checkpoint) {
      const delta = new ApiKeyQuotaLedger()
      addPendingCharges(db, delta, checkpoint)
      const upsert = db.prepare(
        "INSERT INTO api_key_quota_usage (api_key_id, period, period_start_ms, used_cost_nanos) VALUES (?, ?, ?, ?) ON CONFLICT(api_key_id, period, period_start_ms) DO UPDATE SET used_cost_nanos = api_key_quota_usage.used_cost_nanos + excluded.used_cost_nanos",
      )
      for (const bucket of delta.snapshot()) {
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
    }
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}
