import consola from "consola"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import { registerProcessCleanup } from "~/lib/process-cleanup"
import { isSqliteRuntimeSupported, SqliteDbStore } from "~/lib/sqlite"

export interface ResponseContinuationRecord {
  connectionId: string
  sessionId: string
  responseId: string
}

// Keep the latest completed record per connection, without automatic deletion.
// No conversation contents are stored.
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
        session_id TEXT NOT NULL,
        response_id TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
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
      `
      INSERT INTO response_continuations (
        connection_id, session_id, response_id, updated_at_ms
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET
        session_id = excluded.session_id,
        response_id = excluded.response_id, updated_at_ms = excluded.updated_at_ms
    `,
    ).run(record.connectionId, record.sessionId, record.responseId, now)
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
