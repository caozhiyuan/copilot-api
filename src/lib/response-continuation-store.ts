import consola from "consola"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import { registerProcessCleanup } from "~/lib/process-cleanup"
import { isSqliteRuntimeSupported, SqliteDbStore } from "~/lib/sqlite"

export interface ResponseContinuationRecord {
  connectionId: string
  scopeKey: string
  sessionId: string
  responseId: string
  requestHash: string
  prefixItemCount: number
  prefixHash: string
  expiresAt: number
}

// This table records live-connection metadata, never conversation contents.
// It is deliberately not read to restore a chain after reconnect or restart.
const store = new SqliteDbStore({
  getPath: () =>
    process.env.COPILOT_API_SQLITE_DB_PATH
    ?? path.join(PATHS.APP_DIR, "copilot-api.sqlite"),
  initialize: (db) => {
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 1000")
    db.exec(`
      CREATE TABLE IF NOT EXISTS response_continuations (
        connection_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        response_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        prefix_item_count INTEGER NOT NULL,
        prefix_hash TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_response_continuations_expiry
      ON response_continuations(expires_at_ms);
    `)
  },
})

let writeQueue: Promise<void> = Promise.resolve()

function enqueue(write: () => Promise<void>): void {
  if (!isSqliteRuntimeSupported()) return
  writeQueue = writeQueue.then(write).catch((error: unknown) => {
    consola.warn("Failed to persist response continuation metadata", error)
  })
}

export function saveResponseContinuation(
  record: ResponseContinuationRecord,
): void {
  enqueue(async () => {
    const db = await store.getDb()
    const now = Date.now()
    db.prepare(
      "DELETE FROM response_continuations WHERE expires_at_ms <= ?",
    ).run(now)
    db.prepare(
      `
      INSERT INTO response_continuations (
        connection_id, scope_key, session_id, response_id, request_hash,
        prefix_item_count, prefix_hash, updated_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET
        scope_key = excluded.scope_key, session_id = excluded.session_id,
        response_id = excluded.response_id, request_hash = excluded.request_hash,
        prefix_item_count = excluded.prefix_item_count, prefix_hash = excluded.prefix_hash,
        updated_at_ms = excluded.updated_at_ms, expires_at_ms = excluded.expires_at_ms
    `,
    ).run(
      record.connectionId,
      record.scopeKey,
      record.sessionId,
      record.responseId,
      record.requestHash,
      record.prefixItemCount,
      record.prefixHash,
      now,
      record.expiresAt,
    )
  })
}

export function deleteResponseContinuation(connectionId: string): void {
  enqueue(async () => {
    const db = await store.getDb()
    db.prepare(
      "DELETE FROM response_continuations WHERE connection_id = ?",
    ).run(connectionId)
  })
}

export async function flushResponseContinuations(): Promise<void> {
  await writeQueue
}

export async function closeResponseContinuationStore(): Promise<void> {
  await flushResponseContinuations()
  await store.close().catch((error: unknown) => {
    consola.warn("Failed to close response continuation metadata", error)
  })
}

registerProcessCleanup(closeResponseContinuationStore)
