import consola from "consola"

import {
  getTokenUsageRetentionDays,
  resolveTokenUsageRetentionDays,
} from "~/lib/config/config-store"

import {
  getUsageWorker,
  isTokenUsageStorageEnabled,
  registerUsageStoreShutdownHook,
} from "./runtime"

const TOKEN_USAGE_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

let retentionTimer: ReturnType<typeof setInterval> | undefined
let retentionStarted = false

function stopTokenUsageRetention(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer)
    retentionTimer = undefined
  }
  retentionStarted = false
}

registerUsageStoreShutdownHook(stopTokenUsageRetention)

export async function pruneTokenUsageEvents(options?: {
  nowMs?: number
  retentionDays?: number | null
}): Promise<number> {
  const retentionDays = resolveTokenUsageRetentionDays(
    options && "retentionDays" in options ?
      options.retentionDays
    : getTokenUsageRetentionDays(),
  )
  if (retentionDays === null || !isTokenUsageStorageEnabled()) return 0

  const cutoffMs = (options?.nowMs ?? Date.now()) - retentionDays * DAY_MS
  return getUsageWorker().execute("pruneTokenUsageEvents", cutoffMs)
}

export async function startTokenUsageRetention(): Promise<void> {
  if (retentionStarted) return
  retentionStarted = true
  try {
    await pruneTokenUsageEvents()
  } catch (error) {
    consola.warn("Failed to prune token usage", error)
  }
  retentionTimer = setInterval(() => {
    void pruneTokenUsageEvents().catch((error: unknown) => {
      consola.warn("Failed to prune token usage", error)
    })
  }, TOKEN_USAGE_RETENTION_INTERVAL_MS)
  retentionTimer.unref?.()
}
