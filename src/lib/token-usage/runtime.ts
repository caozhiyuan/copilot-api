import path from "node:path"

import { registerProcessCleanup } from "~/lib/process-cleanup"
import { PATHS } from "~/lib/storage/paths"
import { isSqliteRuntimeSupported } from "~/lib/storage/sqlite"

import { UsageWorker } from "./worker-client"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const DEFAULT_DB_FILENAME = "copilot-api.sqlite"

let worker: UsageWorker | undefined
let closing: Promise<void> | undefined
let closingWorker = false

const shutdownHooks = new Set<() => void | Promise<void>>()
const resetHooks = new Set<() => void>()

function getDbPath(): string {
  return (
    process.env[DB_PATH_ENV] ?? path.join(PATHS.APP_DIR, DEFAULT_DB_FILENAME)
  )
}

export function isTokenUsageStorageEnabled(): boolean {
  return isSqliteRuntimeSupported()
}

export function isUsageStoreClosing(): boolean {
  return closing !== undefined
}

export function isUsageWorkerFailed(): boolean {
  return worker?.failed === true
}

export function getUsageWorker(): UsageWorker {
  if (closingWorker) throw new Error("SQLite usage store is closing")
  if (!worker) {
    worker = new UsageWorker(getDbPath())
    registerProcessCleanup(closeUsageStore)
  }
  return worker
}

export function registerUsageStoreShutdownHook(
  hook: () => void | Promise<void>,
): void {
  shutdownHooks.add(hook)
}

export function registerUsageStoreResetHook(hook: () => void): void {
  resetHooks.add(hook)
}

export function closeUsageStore(): Promise<void> {
  closing ??= (async () => {
    for (const hook of shutdownHooks) {
      await hook()
    }

    const current = worker
    // Settlements can still enqueue writes while the poll and worker drain.
    if (current) await current.waitForIdle()
    closingWorker = true
    try {
      await current?.execute("closeUsageDatabase")
    } finally {
      worker = undefined
      for (const hook of resetHooks) {
        hook()
      }
      await current?.terminate()
    }
  })().finally(() => {
    closingWorker = false
    closing = undefined
  })
  return closing
}
