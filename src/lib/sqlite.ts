import fs from "node:fs/promises"
import path from "node:path"

type SqliteValue = string | number | null
type SqliteColumn = SqliteValue | bigint | Uint8Array
export type SqliteRow = Record<string, SqliteColumn>

export const MINIMUM_NODE_SQLITE_VERSION = "22.13.0"

export interface SqliteStatement<Row = SqliteRow> {
  all: (...values: Array<SqliteValue>) => Array<Row>
  get: (...values: Array<SqliteValue>) => Row | null | undefined
  run: (...values: Array<SqliteValue>) => { changes: number | bigint }
}

export interface SqliteDatabase {
  close?: () => void
  exec: (sql: string) => void
  prepare: <Row = SqliteRow>(sql: string) => SqliteStatement<Row>
}

interface SqliteDbStoreOptions {
  getPath: () => string
  initialize?: (db: SqliteDatabase) => void
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

async function openBunDatabase(dbPath: string): Promise<SqliteDatabase> {
  const specifier = ["bun", "sqlite"].join(":")
  const sqlite = (await import(specifier)) as {
    Database: new (filename: string) => SqliteDatabase
  }
  return new sqlite.Database(dbPath)
}

async function loadNodeSqliteModule(): Promise<{
  DatabaseSync: new (location: string) => SqliteDatabase
}> {
  const nodeVersion = process.versions.node
  if (!isNodeSqliteSupportedVersion(nodeVersion)) {
    throw new UnsupportedNodeSqliteRuntimeError(nodeVersion)
  }

  const emitWarning = process.emitWarning.bind(process) as (
    ...args: unknown[]
  ) => void
  process.emitWarning = (warning: unknown, ...args: unknown[]) => {
    if (
      typeof warning === "string"
      && warning.includes("SQLite is an experimental feature")
    ) {
      return
    }
    return emitWarning(warning, ...args)
  }

  const specifier = ["node", "sqlite"].join(":")
  try {
    return (await import(specifier)) as {
      DatabaseSync: new (location: string) => SqliteDatabase
    }
  } catch (error) {
    throw new UnsupportedNodeSqliteRuntimeError(nodeVersion, error)
  } finally {
    process.emitWarning = emitWarning
  }
}

async function openNodeDatabase(dbPath: string): Promise<SqliteDatabase> {
  const sqlite = await loadNodeSqliteModule()
  return new sqlite.DatabaseSync(dbPath)
}

export async function openSqliteDatabase(
  dbPath: string,
): Promise<SqliteDatabase> {
  const dir = path.dirname(dbPath)
  if (dbPath !== ":memory:" && dir !== ".") {
    await fs.mkdir(dir, { recursive: true })
  }
  return isBunRuntime() ? openBunDatabase(dbPath) : openNodeDatabase(dbPath)
}

export class SqliteDbStore {
  private dbPromise: Promise<SqliteDatabase> | null = null
  private readonly options: SqliteDbStoreOptions

  constructor(options: SqliteDbStoreOptions) {
    this.options = options
  }

  getDb(): Promise<SqliteDatabase> {
    this.dbPromise ??= this.open()
    return this.dbPromise
  }

  async close(input?: {
    beforeClose?: (db: SqliteDatabase) => void
  }): Promise<void> {
    const currentDbPromise = this.dbPromise
    this.dbPromise = null

    if (!currentDbPromise) {
      return
    }

    const db = await currentDbPromise
    input?.beforeClose?.(db)
    db.close?.()
  }

  private async open(): Promise<SqliteDatabase> {
    const db = await openSqliteDatabase(this.options.getPath())
    this.options.initialize?.(db)
    return db
  }
}
