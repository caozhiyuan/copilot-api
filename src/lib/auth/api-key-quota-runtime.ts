import consola from "consola"

import type { GatewayApiKeyConfig } from "~/lib/config/api-key-config"
import type { SqliteDatabase } from "~/lib/storage/sqlite"
import { COST_NANOS_PER_UNIT, toCostNanos } from "~/lib/token-usage/currency"
import { getUsageDb } from "~/lib/token-usage/db"
import {
  getUsageWorker,
  isTokenUsageStorageEnabled,
  isUsageStoreClosing,
  isUsageWorkerFailed,
  registerUsageStoreResetHook,
  registerUsageStoreShutdownHook,
} from "~/lib/token-usage/runtime"
import type { ApiKeyQuotaBucket, ApiKeyQuotaUsage } from "~/lib/types/api-key"

import { ApiKeyQuotaLedger, apiKeyQuotaWindow } from "./api-key-quota"
import {
  persistApiKeyQuotaLedger,
  readApiKeyQuotaLedger,
} from "./api-key-quota-store"

interface PendingCharge {
  at: number
  costNanos: number
  completion: Promise<void>
}

interface QuotaState {
  dayStartMs: number
  ledger: ApiKeyQuotaLedger
  pending: Map<string, Set<PendingCharge>>
  ready: Promise<void>
}

let quotaTimer: ReturnType<typeof setInterval> | undefined
let quotaWriteFailed = false
let quotaState: QuotaState | undefined

registerUsageStoreShutdownHook(() => {
  if (quotaTimer) clearInterval(quotaTimer)
  quotaTimer = undefined
})

registerUsageStoreResetHook(() => {
  quotaState = undefined
  quotaWriteFailed = false
})

export async function persistApiKeyQuotas(db?: SqliteDatabase): Promise<void> {
  persistApiKeyQuotaLedger(db ?? (await getUsageDb()))
}

export async function readQuotaBuckets(
  dayStartMs: number,
  monthStartMs: number,
  db?: SqliteDatabase,
): Promise<Array<ApiKeyQuotaBucket>> {
  const ledger = readApiKeyQuotaLedger(db ?? (await getUsageDb()))
  return ledger
    .snapshot()
    .filter(
      (bucket) =>
        bucket.period === "lifetime"
        || bucket.period_start_ms
          >= (bucket.period === "day" ? dayStartMs : monthStartMs),
    )
}

export function trackApiKeyUsageWrite(options: {
  apiKeyId: string | null | undefined
  costNanos: number | null | undefined
  at: number
  write: () => Promise<boolean>
}): void {
  const state = quotaState
  const { apiKeyId: id, costNanos, at, write } = options

  const completion = (async () => {
    try {
      const inserted = await write()
      if (inserted && id && costNanos != null) {
        state?.ledger.add(id, costNanos, at)
      }
    } catch (error) {
      if (id) quotaWriteFailed = true
      consola.warn("Failed to record token usage", error)
    }
  })()

  // Writes already submitted when the ledger loads are included in its replay.
  // Track subsequent charges until SQLite confirms whether the row was new.
  if (!state || !id || costNanos == null || costNanos <= 0) return
  const pending = state.pending.get(id) ?? new Set<PendingCharge>()
  const charge = { at, costNanos, completion }
  pending.add(charge)
  state.pending.set(id, pending)
  void completion.then(() => {
    pending.delete(charge)
    if (pending.size === 0) state.pending.delete(id)
  })
}

function loadQuotaState(): QuotaState {
  if (!isTokenUsageStorageEnabled())
    throw new Error("API key quotas require SQLite support")
  if (isUsageStoreClosing()) throw new Error("SQLite usage store is closing")

  const now = Date.now()
  if (!quotaState || now < quotaState.dayStartMs) {
    // Older periods stay on disk and are restored if the clock moves back.
    const dayStartMs = apiKeyQuotaWindow("day", now).startMs
    const monthStartMs = apiKeyQuotaWindow("month", now).startMs
    const ledger = new ApiKeyQuotaLedger()
    const ready = getUsageWorker()
      .execute("readQuotaBuckets", dayStartMs, monthStartMs)
      .then((buckets) => {
        ledger.restore(buckets)
        if (isUsageStoreClosing() || quotaTimer) return
        quotaTimer = setInterval(() => {
          void flushApiKeyQuotas().catch((error: unknown) =>
            consola.warn("Failed to persist API key quotas", error),
          )
        }, 5000)
        quotaTimer.unref?.()
      })
      .catch((error: unknown) => {
        if (quotaState?.ready === ready) quotaState = undefined
        throw error
      })
    quotaState = { dayStartMs, ledger, pending: new Map(), ready }
  }
  return quotaState
}

export async function initializeApiKeyQuotas(): Promise<void> {
  await loadQuotaState().ready
}

export async function flushApiKeyQuotas(): Promise<void> {
  if (!isTokenUsageStorageEnabled()) return
  await getUsageWorker().execute("flushApiKeyQuotas")
}

function readQuotaBalance(
  state: QuotaState,
  key: GatewayApiKeyConfig,
  now: number,
) {
  if (isUsageStoreClosing() || quotaWriteFailed || isUsageWorkerFailed())
    throw new Error("API key usage could not be persisted")
  const quota = key.quota
  const period = quota?.period ?? "lifetime"
  const window = apiKeyQuotaWindow(period, now)
  const usedCostNanos = state.ledger.used(key.id, period, window)
  return {
    ...window,
    usedCostNanos,
    remainingCostNanos:
      quota ? Math.max(0, toCostNanos(quota.amount) - usedCostNanos) : null,
  }
}

async function readSettledQuotaBalance(
  key: GatewayApiKeyConfig,
): Promise<ReturnType<typeof readQuotaBalance>> {
  const state = loadQuotaState()
  await state.ready
  let pending = state.pending.get(key.id)
  while (pending?.size) {
    await Promise.all(Array.from(pending, (charge) => charge.completion))
    pending = state.pending.get(key.id)
  }
  const now = Date.now()
  if (state !== quotaState || now < state.dayStartMs)
    return readSettledQuotaBalance(key)
  return readQuotaBalance(state, key, now)
}

export async function getApiKeyQuotaUsage(
  key: GatewayApiKeyConfig,
): Promise<Omit<ApiKeyQuotaUsage, "id">> {
  const { usedCostNanos, remainingCostNanos, endMs } =
    await readSettledQuotaBalance(key)
  return {
    usedAmount: usedCostNanos / COST_NANOS_PER_UNIT,
    remainingAmount:
      remainingCostNanos === null ? null : (
        remainingCostNanos / COST_NANOS_PER_UNIT
      ),
    resetsAt: endMs,
  }
}

export async function getApiKeyQuotaAdmission(
  key: GatewayApiKeyConfig,
): Promise<ReturnType<typeof readQuotaBalance>> {
  const state = loadQuotaState()
  await state.ready
  const now = Date.now()
  if (state !== quotaState || now < state.dayStartMs)
    return getApiKeyQuotaAdmission(key)
  const balance = readQuotaBalance(state, key, now)
  const { startMs, endMs, remainingCostNanos } = balance
  const pending = state.pending.get(key.id)
  if (!pending || !remainingCostNanos) return balance

  let pendingCost = 0
  for (const charge of pending) {
    if (charge.at >= startMs && (endMs === null || charge.at < endMs))
      pendingCost += charge.costNanos
  }
  // Only a charge that could exhaust this key must be confirmed before
  // admitting it. A duplicate may settle without consuming any balance.
  return pendingCost >= remainingCostNanos ?
      readSettledQuotaBalance(key)
    : balance
}
