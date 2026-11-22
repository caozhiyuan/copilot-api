import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  isNodeSqliteSupportedVersion,
  isSqliteRuntimeSupported,
  SqliteDbStore,
  type SqliteDatabase,
} from "~/lib/storage/sqlite"
import { initializeTokenUsageDb } from "~/lib/token-usage/db"

describe("sqlite runtime support", () => {
  test("detects the minimum Node.js version for node:sqlite", () => {
    expect(isNodeSqliteSupportedVersion("22.12.0")).toBe(false)
    expect(isNodeSqliteSupportedVersion("22.13.0")).toBe(true)
    expect(isNodeSqliteSupportedVersion("23.0.0")).toBe(true)
  })

  test("disables SQLite on older Node.js versions while allowing Bun", () => {
    expect(
      isSqliteRuntimeSupported({ isBun: false, nodeVersion: "22.12.0" }),
    ).toBe(false)
    expect(
      isSqliteRuntimeSupported({ isBun: false, nodeVersion: "22.13.0" }),
    ).toBe(true)
    expect(
      isSqliteRuntimeSupported({ isBun: true, nodeVersion: "20.0.0" }),
    ).toBe(true)
  })
})

describe("SqliteDbStore", () => {
  test("closes the opened handle and retries after an initialization failure", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-sqlite-"))
    const dbPath = path.join(tempDir, "usage.sqlite")
    let attempts = 0
    let failedHandle: SqliteDatabase | undefined

    const store = new SqliteDbStore({
      getPath: () => dbPath,
      initialize: (db) => {
        attempts += 1
        if (attempts === 1) {
          failedHandle = db
          throw new Error("SQLITE_BUSY")
        }
        db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY)")
      },
    })

    try {
      let firstError: unknown
      try {
        await store.getDb()
      } catch (error) {
        firstError = error
      }
      expect(firstError).toBeInstanceOf(Error)
      expect((firstError as Error).message).toBe("SQLITE_BUSY")
      expect(failedHandle).toBeDefined()

      // The failed handle must already be closed so subsequent open + cleanup work.
      const db = await store.getDb()
      expect(db).not.toBe(failedHandle)
      expect(attempts).toBe(2)

      // Successful handle stays memoized.
      expect(await store.getDb()).toBe(db)
      expect(attempts).toBe(2)
    } finally {
      await store.close()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test("retries after a transient getPath failure", async () => {
    let shouldFail = true
    const store = new SqliteDbStore({
      getPath: () => {
        if (shouldFail) {
          shouldFail = false
          throw new Error("path not ready")
        }
        return ":memory:"
      },
    })

    try {
      let firstError: unknown
      try {
        await store.getDb()
      } catch (error) {
        firstError = error
      }
      expect(firstError).toBeInstanceOf(Error)
      expect((firstError as Error).message).toBe("path not ready")
      const db = await store.getDb()
      expect(db).toBeDefined()
    } finally {
      await store.close()
    }
  })

  test("sets busy_timeout before switching journal_mode to WAL", () => {
    const statements: Array<string> = []
    const fakeDb: SqliteDatabase = {
      exec: (sql) => {
        statements.push(sql.trim())
      },
      prepare: () => ({
        all: () => [],
        get: () => undefined,
        run: () => ({ changes: 0 }),
      }),
    }

    initializeTokenUsageDb(fakeDb)

    const busyIndex = statements.indexOf("PRAGMA busy_timeout = 5000")
    const walIndex = statements.indexOf("PRAGMA journal_mode = WAL")
    expect(busyIndex).toBeGreaterThanOrEqual(0)
    expect(walIndex).toBeGreaterThan(busyIndex)
  })
})
