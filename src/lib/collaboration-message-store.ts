import { createHash } from "node:crypto"
import path from "node:path"

import type { ResponsesPayload } from "~/lib/types/responses"

import { PATHS } from "./paths"
import { registerProcessCleanup } from "./process-cleanup"
import { SqliteDbStore } from "./sqlite"

// Codex v2 labels delegated message strings as encrypted even when an ordinary
// upstream tool emitted plaintext. Only relabel values previously emitted by
// our adapter. Persist hashes (never message bodies) so resumed child threads
// work after a gateway restart without guessing whether ciphertext is text.
export class PlaintextCollaborationStore {
  private readonly store: SqliteDbStore

  constructor(getPath: () => string) {
    this.store = new SqliteDbStore({
      getPath,
      initialize: (db) => {
        db.exec("PRAGMA busy_timeout = 5000")
        db.exec("PRAGMA journal_mode = WAL")
        db.exec(`CREATE TABLE IF NOT EXISTS copilot_plaintext_collaboration_messages (
          digest TEXT PRIMARY KEY NOT NULL
        ) WITHOUT ROWID`)
      },
    })
  }

  async ready(): Promise<void> {
    await this.store.getDb()
  }

  async remember(messages: Array<string>): Promise<void> {
    if (messages.length === 0) return
    const db = await this.store.getDb()
    const insert = db.prepare(
      "INSERT OR IGNORE INTO copilot_plaintext_collaboration_messages (digest) VALUES (?)",
    )
    for (const message of new Set(messages)) insert.run(digest(message))
  }

  async restoreAgentMessages(payload: ResponsesPayload): Promise<number> {
    if (!Array.isArray(payload.input)) return 0
    const candidates: Array<
      Record<string, unknown> & { encrypted_content: string }
    > = []
    for (const item of payload.input) {
      if (
        !isRecord(item)
        || item.type !== "agent_message"
        || !Array.isArray(item.content)
      )
        continue
      for (const part of item.content) {
        if (
          isRecord(part)
          && part.type === "encrypted_content"
          && typeof part.encrypted_content === "string"
        ) {
          candidates.push(
            part as Record<string, unknown> & { encrypted_content: string },
          )
        }
      }
    }
    if (candidates.length === 0) return 0
    const db = await this.store.getDb()
    const lookup = db.prepare(
      "SELECT 1 FROM copilot_plaintext_collaboration_messages WHERE digest = ?",
    )
    let restored = 0
    for (const part of candidates) {
      if (!lookup.get(digest(part.encrypted_content))) continue
      part.type = "input_text"
      part.text = part.encrypted_content
      Reflect.deleteProperty(part, "encrypted_content")
      restored += 1
    }
    return restored
  }

  async close(): Promise<void> {
    await this.store.close()
  }
}

const store = new PlaintextCollaborationStore(
  () =>
    process.env.COPILOT_API_SQLITE_DB_PATH
    ?? path.join(PATHS.APP_DIR, "copilot-api.sqlite"),
)

export const preparePlaintextCollaborationStore = (): Promise<void> =>
  store.ready()
export const rememberPlaintextCollaborationMessages = (
  messages: Array<string>,
): Promise<void> => store.remember(messages)
export const restorePlaintextCollaborationMessages = (
  payload: ResponsesPayload,
): Promise<number> => store.restoreAgentMessages(payload)
export const closePlaintextCollaborationStore = (): Promise<void> =>
  store.close()

registerProcessCleanup(closePlaintextCollaborationStore)

function digest(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
