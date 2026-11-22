import { workerData } from "node:worker_threads"

import {
  initializeApiKeyQuotaTables,
  persistApiKeyQuotaLedger,
} from "~/lib/auth/api-key-quota-store"
import { SqliteDbStore, type SqliteDatabase } from "~/lib/storage/sqlite"
import { initializeVideoUsageJobs } from "~/lib/video-settlement/db"

const tokenUsageDbStore = new SqliteDbStore({
  getPath: () => {
    if (typeof workerData !== "string")
      throw new Error("SQLite usage database requires a worker")
    return workerData
  },
  initialize: initializeTokenUsageDb,
})

export function getUsageDb(): Promise<SqliteDatabase> {
  return tokenUsageDbStore.getDb()
}

export function apiKeyUsageTable(apiKeyId?: string | null): string {
  if (apiKeyId === undefined) return "token_usage_events"
  const filter =
    apiKeyId === null ? "IS NULL" : "= '" + apiKeyId.replaceAll("'", "''") + "'"
  return "(SELECT * FROM token_usage_events WHERE api_key_id " + filter + ")"
}

export function initializeTokenUsageDb(db: SqliteDatabase): void {
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      created_at_utc TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      provider_name TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_nano_aiu INTEGER,
      cost_currency TEXT,
      total_cost_nanos INTEGER,
      cost_source TEXT
    )
  `)
  ensureColumn(db, "api_key_id", "TEXT")
  ensureColumn(db, "api_key_name", "TEXT")
  ensureColumn(db, "api_key_cost_nanos", "INTEGER")
  initializeApiKeyQuotaTables(db)
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_token_usage_events_api_key ON token_usage_events(api_key_id, created_at_ms)",
  )
  ensureColumn(db, "user_id", "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, "user_agent", "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, "total_tokens", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, "total_nano_aiu", "INTEGER")
  ensureColumn(db, "cost_currency", "TEXT")
  ensureColumn(db, "total_cost_nanos", "INTEGER")
  ensureColumn(db, "cost_source", "TEXT")
  ensureColumn(db, "request_id", "TEXT")
  ensureColumn(db, "upstream_request_id", "TEXT")
  ensureColumn(db, "first_token_ms", "REAL")
  ensureColumn(db, "duration_ms", "REAL")
  ensureColumn(db, "request_outcome", "TEXT")
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_events_upstream_request
    ON token_usage_events(source, provider_name, endpoint, upstream_request_id)
  `)
  initializeVideoUsageJobs(db)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_request_id
    ON token_usage_events(request_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_created_at_ms
    ON token_usage_events(created_at_ms)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_model
    ON token_usage_events(model)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_trace_id
    ON token_usage_events(trace_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_session_id
    ON token_usage_events(session_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_user_id
    ON token_usage_events(user_id)
  `)
}

function ensureColumn(
  db: SqliteDatabase,
  name: string,
  definition: string,
): void {
  const rows = db.prepare("PRAGMA table_info(token_usage_events)").all()
  const hasColumn = rows.some((row) => row.name === name)
  if (!hasColumn) {
    db.exec(`ALTER TABLE token_usage_events ADD COLUMN ${name} ${definition}`)
  }
}

export async function closeUsageDatabase(): Promise<void> {
  await tokenUsageDbStore.close({
    beforeClose: (db) => {
      persistApiKeyQuotaLedger(db)
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      } catch {
        // Ignore WAL cleanup errors during shutdown.
      }
    },
  })
}
