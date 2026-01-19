import { Database } from "bun:sqlite"
import consola from "consola"
import path from "node:path"

import { PATHS } from "./paths"

const ADMIN_DB_FILENAME = "admin.sqlite"
const DEFAULT_DB_PATH = path.join(PATHS.APP_DIR, ADMIN_DB_FILENAME)

let sharedDb: Database | null = null
let initialized = false

const INIT_WARN_THROTTLE_MS = 30_000

let lastInitWarnAtMs = 0
let suppressedInitWarnCount = 0

function warnAdminDbInitFailure(error: unknown): void {
  const now = Date.now()

  if (now - lastInitWarnAtMs < INIT_WARN_THROTTLE_MS) {
    suppressedInitWarnCount++
    return
  }

  const suppressed = suppressedInitWarnCount
  suppressedInitWarnCount = 0
  lastInitWarnAtMs = now

  const suffix =
    suppressed > 0 ? ` (suppressed ${suppressed} similar errors)` : ""
  consola.warn(
    `Failed to initialize admin DB; admin features disabled${suffix}`,
    error,
  )
}

export function getAdminDbPath(): string {
  return DEFAULT_DB_PATH
}

export function openAdminDb(filePath: string = DEFAULT_DB_PATH): Database {
  return new Database(filePath)
}

export function initAdminDb(db: Database): void {
  // Pragmas: prefer WAL for concurrent reads, keep writes fast.
  // Note: journal_mode=WAL is per-database and persists in the DB file.
  db.run("PRAGMA journal_mode = WAL;")
  db.run("PRAGMA synchronous = NORMAL;")
  db.run("PRAGMA busy_timeout = 3000;")
  db.run("PRAGMA foreign_keys = ON;")

  migrateAdminDb(db)
}

export function getAdminDb(): Database {
  if (!sharedDb) {
    sharedDb = openAdminDb()
  }
  if (!initialized) {
    try {
      initAdminDb(sharedDb)
      initialized = true
    } catch (error) {
      // Admin DB is a best-effort feature; server should continue to run.
      warnAdminDbInitFailure(error)
    }
  }
  return sharedDb
}

export function getAdminDbUserVersion(db: Database = getAdminDb()): number {
  try {
    const row = db.query("PRAGMA user_version;").get() as {
      user_version?: number
    } | null
    return row?.user_version ?? 0
  } catch {
    return 0
  }
}

function migrateAdminDb(db: Database): void {
  const row = db.query("PRAGMA user_version;").get() as {
    user_version?: number
  } | null
  const current = row?.user_version ?? 0

  if (current >= 4) {
    return
  }

  if (current < 1) {
    // v1: request_log table
    db.run(`
      CREATE TABLE IF NOT EXISTS request_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,

        started_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER,
        duration_ms INTEGER,
        ttfb_ms INTEGER,

        method TEXT NOT NULL,
        path TEXT NOT NULL,
        upstream_endpoint TEXT,
        stream INTEGER NOT NULL DEFAULT 0,

        account_id TEXT,
        account_type TEXT,
        cost_units REAL,
        client_model TEXT,
        upstream_model TEXT,

        client_ip TEXT,
        client_ip_source TEXT,
        user_agent TEXT,

        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_total INTEGER,
        tokens_cached_input INTEGER,
        usage_json TEXT,

        premium_remaining_before REAL,
        premium_remaining_after REAL,
        premium_remaining_diff REAL,
        premium_unlimited_before INTEGER,
        premium_unlimited_after INTEGER,

        http_status INTEGER,
        error_name TEXT,
        error_status INTEGER,
        error_message TEXT,
        selection_failure_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_request_log_started_at
        ON request_log(started_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_request_log_account_started_at
        ON request_log(account_id, started_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_request_log_model_started_at
        ON request_log(upstream_model, started_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_request_log_endpoint_started_at
        ON request_log(upstream_endpoint, started_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_request_log_status_started_at
        ON request_log(http_status, started_at_ms DESC);

      PRAGMA user_version = 1;
    `)
  }

  if (current < 2) {
    // v2: request_log session correlation fields
    db.run(`
      ALTER TABLE request_log ADD COLUMN user_id TEXT;
      ALTER TABLE request_log ADD COLUMN safety_identifier TEXT;
      ALTER TABLE request_log ADD COLUMN prompt_cache_key TEXT;
      ALTER TABLE request_log ADD COLUMN initiator TEXT;
      ALTER TABLE request_log ADD COLUMN upstream_request_id TEXT;

      PRAGMA user_version = 2;
    `)
  }

  if (current < 3) {
    // v3: index for session lookup
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_request_log_session_finished
        ON request_log(
          prompt_cache_key,
          safety_identifier,
          finished_at_ms DESC
        )
        WHERE finished_at_ms IS NOT NULL
          AND tokens_input IS NOT NULL;

      PRAGMA user_version = 3;
    `)
  }

  if (current < 4) {
    // v4: index for session lookup by client model
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_request_log_session_finished_by_client_model
        ON request_log(
          prompt_cache_key,
          safety_identifier,
          client_model,
          finished_at_ms DESC
        )
        WHERE finished_at_ms IS NOT NULL
          AND tokens_input IS NOT NULL;

      PRAGMA user_version = 4;
    `)
  }
}
