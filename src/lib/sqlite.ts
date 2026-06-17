import fs from "node:fs/promises"
import path from "node:path"

export type SqlValue = string | number | null

export const MINIMUM_NODE_SQLITE_VERSION = "22.13.0"

// Async database abstraction shared by every backend (local SQLite and remote
// Turso/libsql). `prepare()` stays synchronous and returns a statement whose
// `all/get/run` are async, so call sites only need to add `await`.
export interface AsyncStatement {
  all: (...values: Array<SqlValue>) => Promise<Array<Record<string, unknown>>>
  get: (
    ...values: Array<SqlValue>
  ) => Promise<Record<string, unknown> | undefined>
  run: (...values: Array<SqlValue>) => Promise<void>
}

export interface AsyncDatabase {
  // Distinguishes backends so SQLite-only PRAGMAs can be gated out for Turso.
  kind: "sqlite" | "turso"
  exec: (sql: string) => Promise<void>
  prepare: (sql: string) => AsyncStatement
  close: () => Promise<void>
}

// Shape of the native synchronous SQLite drivers (`bun:sqlite` / `node:sqlite`).
interface RawSqliteStatement {
  all: (...values: Array<SqlValue>) => Array<unknown>
  get: (...values: Array<SqlValue>) => unknown
  run: (...values: Array<SqlValue>) => unknown
}

interface RawSqliteDatabase {
  close?: () => void
  exec: (sql: string) => unknown
  prepare: (sql: string) => RawSqliteStatement
}

interface AsyncDbStoreOptions {
  open: () => Promise<AsyncDatabase>
  initialize?: (db: AsyncDatabase) => void | Promise<void>
}

const isBunRuntime = (): boolean =>
  Boolean((globalThis as { Bun?: unknown }).Bun)

function parseNodeVersion(version: string): Array<number> {
  return version.split(".", 3).map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  })
}

interface SqliteRuntimeSupportInput {
  isBun?: boolean
  nodeVersion?: string
}

export function isNodeSqliteSupportedVersion(version: string): boolean {
  const current = parseNodeVersion(version)
  const minimum = parseNodeVersion(MINIMUM_NODE_SQLITE_VERSION)

  for (const [index, minimumPart] of minimum.entries()) {
    const currentPart = current[index] ?? 0
    if (currentPart > minimumPart) return true
    if (currentPart < minimumPart) return false
  }

  return true
}

export function isSqliteRuntimeSupported(
  input: SqliteRuntimeSupportInput = {},
): boolean {
  if (input.isBun ?? isBunRuntime()) {
    return true
  }

  return isNodeSqliteSupportedVersion(
    input.nodeVersion ?? process.versions.node,
  )
}

function getUnsupportedNodeSqliteMessage(nodeVersion: string): string {
  return (
    `SQLite-backed token usage requires Bun or Node.js >= ${MINIMUM_NODE_SQLITE_VERSION}. `
    + `Detected Node.js ${nodeVersion}. Upgrade Node.js or run the CLI with Bun, for example `
    + "`bunx --bun @jeffreycao/copilot-api@latest start` or `bun run start start`."
  )
}

export class UnsupportedNodeSqliteRuntimeError extends Error {
  constructor(nodeVersion: string, cause?: unknown) {
    super(getUnsupportedNodeSqliteMessage(nodeVersion), { cause })
    this.name = "UnsupportedNodeSqliteRuntimeError"
  }
}

async function openBunDatabase(dbPath: string): Promise<RawSqliteDatabase> {
  const specifier = ["bun", "sqlite"].join(":")
  const sqlite = (await import(specifier)) as {
    Database: new (filename: string) => RawSqliteDatabase
  }
  return new sqlite.Database(dbPath)
}

async function loadNodeSqliteModule(): Promise<{
  DatabaseSync: new (location: string) => RawSqliteDatabase
}> {
  const nodeVersion = process.versions.node
  if (!isNodeSqliteSupportedVersion(nodeVersion)) {
    throw new UnsupportedNodeSqliteRuntimeError(nodeVersion)
  }

  const specifier = ["node", "sqlite"].join(":")
  try {
    return (await import(specifier)) as {
      DatabaseSync: new (location: string) => RawSqliteDatabase
    }
  } catch (error) {
    throw new UnsupportedNodeSqliteRuntimeError(nodeVersion, error)
  }
}

async function openNodeDatabase(dbPath: string): Promise<RawSqliteDatabase> {
  const sqlite = await loadNodeSqliteModule()
  return new sqlite.DatabaseSync(dbPath)
}

function wrapRawSqliteDatabase(raw: RawSqliteDatabase): AsyncDatabase {
  return {
    kind: "sqlite",
    exec: (sql) => Promise.resolve(raw.exec(sql)).then(() => undefined),
    prepare: (sql) => {
      const statement = raw.prepare(sql)
      return {
        all: (...values) =>
          Promise.resolve(
            statement.all(...values) as Array<Record<string, unknown>>,
          ),
        get: (...values) =>
          Promise.resolve(
            statement.get(...values) as Record<string, unknown> | undefined,
          ),
        run: (...values) =>
          Promise.resolve(statement.run(...values)).then(() => undefined),
      }
    },
    close: () => Promise.resolve(raw.close?.()).then(() => undefined),
  }
}

export async function openSqliteDatabase(
  dbPath: string,
): Promise<AsyncDatabase> {
  const dir = path.dirname(dbPath)
  if (dbPath !== ":memory:" && dir !== ".") {
    await fs.mkdir(dir, { recursive: true })
  }
  const raw =
    isBunRuntime() ?
      await openBunDatabase(dbPath)
    : await openNodeDatabase(dbPath)
  return wrapRawSqliteDatabase(raw)
}

export class AsyncDbStore {
  private dbPromise: Promise<AsyncDatabase> | null = null
  private readonly options: AsyncDbStoreOptions

  constructor(options: AsyncDbStoreOptions) {
    this.options = options
  }

  getDb(): Promise<AsyncDatabase> {
    this.dbPromise ??= this.open()
    return this.dbPromise
  }

  async close(input?: {
    beforeClose?: (db: AsyncDatabase) => void | Promise<void>
  }): Promise<void> {
    const currentDbPromise = this.dbPromise
    this.dbPromise = null

    if (!currentDbPromise) {
      return
    }

    const db = await currentDbPromise
    await input?.beforeClose?.(db)
    await db.close()
  }

  private async open(): Promise<AsyncDatabase> {
    const db = await this.options.open()
    await this.options.initialize?.(db)
    return db
  }
}
