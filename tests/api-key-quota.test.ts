import { afterEach, describe, expect, test } from "bun:test"
import { ApiKeyQuotaLedger, apiKeyQuotaWindow } from "~/lib/auth/api-key-quota"
import {
  initializeApiKeyQuotaTables,
  readApiKeyQuotaLedger,
  persistApiKeyQuotaLedger,
} from "~/lib/auth/api-key-quota-store"
import { openSqliteDatabase, type SqliteDatabase } from "~/lib/storage/sqlite"

const databases: Array<SqliteDatabase> = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close?.()
})
async function database() {
  const db = await openSqliteDatabase(":memory:")
  databases.push(db)
  db.exec(
    "CREATE TABLE token_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, api_key_id TEXT, api_key_cost_nanos INTEGER, created_at_ms INTEGER NOT NULL)",
  )
  initializeApiKeyQuotaTables(db)
  return db
}
describe("API key spending limit", () => {
  test("uses calendar periods, counts settled usage immediately and resets by period", () => {
    const before = new Date(2026, 0, 31, 23, 59).getTime()
    const after = new Date(2026, 1, 1, 0, 1).getTime()
    const ledger = new ApiKeyQuotaLedger()
    ledger.add("one", 10, before)
    ledger.add("one", 5, after)
    ledger.add("two", 99, after)
    ledger.add("one", -1, after)
    ledger.add("one", NaN, after)
    const beforeDay = apiKeyQuotaWindow("day", before)
    expect(ledger.used("one", "day", beforeDay)).toBe(10)
    expect(
      ledger.used("one", "month", apiKeyQuotaWindow("month", before)),
    ).toBe(10)
    expect(ledger.used("one", "day", apiKeyQuotaWindow("day", after))).toBe(5)
    expect(ledger.used("one", "month", apiKeyQuotaWindow("month", after))).toBe(
      5,
    )
    expect(ledger.used("one", "lifetime")).toBe(15)
    expect(ledger.used("missing", "lifetime")).toBe(0)
    expect(apiKeyQuotaWindow("lifetime", before)).toEqual({
      startMs: 0,
      endMs: null,
    })
    expect(apiKeyQuotaWindow("month", before).endMs).toBe(
      new Date(2026, 1, 1).getTime(),
    )
    expect(apiKeyQuotaWindow("day", before).endMs).toBe(
      new Date(2026, 1, 1).getTime(),
    )
    const restored = new ApiKeyQuotaLedger()
    restored.restore(ledger.snapshot())
    expect(restored.used("one", "lifetime")).toBe(15)
    const snapshot = ledger.snapshot()
    snapshot[0].used_cost_nanos = 1234
    expect(ledger.used("one", "day", beforeDay)).toBe(10)
    expect(ledger.used("one", "lifetime")).toBe(15)
  })
  test("replays uncheckpointed events once and preserves quotas after history cleanup", async () => {
    const db = await database()
    const at = Date.now()
    const insert = db.prepare(
      "INSERT INTO token_usage_events (api_key_id, api_key_cost_nanos, created_at_ms) VALUES (?, ?, ?)",
    )
    insert.run(null, 1000, at)
    insert.run("one", 10, at)
    expect(readApiKeyQuotaLedger(db).used("one", "lifetime")).toBe(10)
    persistApiKeyQuotaLedger(db)
    persistApiKeyQuotaLedger(db)
    expect(readApiKeyQuotaLedger(db).used("one", "lifetime")).toBe(10)
    insert.run("one", 5, at)
    insert.run("two", 7, at)
    expect(readApiKeyQuotaLedger(db).used("one", "lifetime")).toBe(15)
    persistApiKeyQuotaLedger(db)
    db.exec("DELETE FROM token_usage_events")
    const restored = readApiKeyQuotaLedger(db)
    expect(restored.used("one", "lifetime")).toBe(15)
    expect(restored.used("two", "lifetime")).toBe(7)
    insert.run("one", 3, at)
    expect(readApiKeyQuotaLedger(db).used("one", "lifetime")).toBe(18)
  })
  test("checkpoints charges without updating untouched quota buckets", async () => {
    const db = await database()
    const insert = db.prepare(
      "INSERT INTO token_usage_events (api_key_id, api_key_cost_nanos, created_at_ms) VALUES (?, ?, ?)",
    )
    const at = Date.now()
    insert.run("unchanged", 10, at)
    insert.run("active", 10, at)
    persistApiKeyQuotaLedger(db)
    db.exec(`
      CREATE TRIGGER prevent_unchanged_bucket_update
      BEFORE UPDATE ON api_key_quota_usage
      WHEN OLD.api_key_id = 'unchanged'
      BEGIN
        SELECT RAISE(ABORT, 'rewrote untouched quota bucket');
      END
    `)
    persistApiKeyQuotaLedger(db)
    insert.run("active", 5, at)
    persistApiKeyQuotaLedger(db)

    const ledger = readApiKeyQuotaLedger(db)
    expect(ledger.used("unchanged", "lifetime")).toBe(10)
    expect(ledger.used("active", "lifetime")).toBe(15)
  })

  test("rolls back both counters and checkpoint when a flush fails", async () => {
    const db = await database()
    db.prepare(
      "INSERT INTO token_usage_events (api_key_id, api_key_cost_nanos, created_at_ms) VALUES (?, ?, ?)",
    ).run("one", 10, Date.now())
    const failing: SqliteDatabase = {
      exec: (sql) => db.exec(sql),
      prepare: <Row>(sql: string) => {
        const statement = db.prepare<Row>(sql)
        if (!sql.startsWith("UPDATE api_key_quota_checkpoint")) return statement
        return {
          all: (...values) => statement.all(...values),
          get: (...values) => statement.get(...values),
          run: () => {
            throw new Error("disk full")
          },
        }
      },
    }
    expect(() => persistApiKeyQuotaLedger(failing)).toThrow("disk full")
    expect(db.prepare("SELECT * FROM api_key_quota_usage").all()).toEqual([])
    expect(
      db.prepare("SELECT event_id FROM api_key_quota_checkpoint").get(),
    ).toEqual({ event_id: 0 })
    persistApiKeyQuotaLedger(db)
    expect(readApiKeyQuotaLedger(db).used("one", "lifetime")).toBe(10)
  })
})
