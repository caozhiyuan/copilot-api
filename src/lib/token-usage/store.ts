import consola from "consola"

import {
  persistApiKeyQuotas,
  readQuotaBuckets,
  trackApiKeyUsageWrite,
} from "~/lib/auth/api-key-quota-runtime"
import type {
  PersistedTokenUsageEvent,
  RequestTiming,
  TokenUsagePageInput,
  TokenUsagePeriod,
} from "~/lib/types/token-usage"
import {
  clearVideoUsageJobPollRow,
  queryDueVideoUsageJobRows,
  readVideoUsageJob,
  updateVideoUsageJobPollRow,
  writeVideoUsageJobRow,
} from "~/lib/video-settlement/db"

import { closeUsageDatabase, getUsageDb } from "./db"
import {
  deleteExpiredUsageEvents,
  writeTokenUsageEvent,
  writeTokenUsageTiming,
} from "./events-db"
import {
  createEmptyDailySummary,
  createEmptyEventsPage,
  createEmptySummary,
} from "./period"
import {
  queryTokenUsageDailySummary,
  queryTokenUsageEventsPage,
  queryTokenUsageSessionsPage,
  queryTokenUsageSummary,
} from "./queries"
import { getUsageWorker, isTokenUsageStorageEnabled } from "./runtime"
import type { UsageDatabaseOperations } from "./worker-client"

export {
  flushApiKeyQuotas,
  getApiKeyQuotaAdmission,
  getApiKeyQuotaUsage,
  initializeApiKeyQuotas,
} from "~/lib/auth/api-key-quota-runtime"
export {
  deferVideoUsageJob,
  getDueVideoUsageJobs,
  getVideoUsageJob,
  saveVideoUsageJob,
  startVideoUsageSettlement,
  stopPollingVideoUsageJob,
} from "~/lib/video-settlement"
export {
  hasAnyToken,
  normalizeOptionalToken,
  normalizeToken,
  resolveTotalTokens,
} from "./normalize"
export { pruneTokenUsageEvents, startTokenUsageRetention } from "./retention"
export { closeUsageStore, isTokenUsageStorageEnabled } from "./runtime"

export type {
  ImageTokenDetails,
  PersistedTokenUsageEvent,
  TokenUsageCost,
  TokenUsageDailyBucket,
  TokenUsageDailySummary,
  TokenUsageEndpoint,
  TokenUsageEventCost,
  TokenUsageEventRecord,
  TokenUsageEventsPage,
  TokenUsageModelSummary,
  TokenUsagePeriod,
  TokenUsageSessionSummary,
  TokenUsageSessionsPage,
  TokenUsageSource,
  TokenUsageSummary,
  TokenUsageTiming,
  TokenUsageTotals,
  UsageTokens,
  VideoUsageJob,
} from "~/lib/types/token-usage"

export function enqueueTokenUsageWrite(event: PersistedTokenUsageEvent): void {
  if (!isTokenUsageStorageEnabled()) return

  trackApiKeyUsageWrite({
    apiKeyId: event.api_key_id,
    costNanos: event.api_key_cost_nanos,
    at: event.created_at_ms,
    write: () => getUsageWorker().execute("writeTokenUsageEvent", event),
  })
}

export function enqueueTokenUsageTiming(timing: RequestTiming): void {
  if (!isTokenUsageStorageEnabled()) return
  const { id, firstTokenMs, durationMs, outcome } = timing
  void (async () => {
    try {
      await getUsageWorker().execute("writeTokenUsageTiming", {
        id,
        firstTokenMs,
        durationMs,
        outcome,
      })
    } catch (error) {
      consola.warn("Failed to record token usage timing", error)
    }
  })()
}

export async function getTokenUsageSummary(
  period: TokenUsagePeriod,
  apiKeyId?: string | null,
) {
  if (!isTokenUsageStorageEnabled()) return createEmptySummary(period)
  return getUsageWorker().execute(
    "getTokenUsageSummary",
    period,
    Date.now(),
    apiKeyId,
  )
}

export async function getTokenUsageDailySummary(
  period: TokenUsagePeriod,
  apiKeyId?: string | null,
) {
  if (!isTokenUsageStorageEnabled()) return createEmptyDailySummary(period)
  return getUsageWorker().execute(
    "getTokenUsageDailySummary",
    period,
    Date.now(),
    apiKeyId,
  )
}

export async function getTokenUsageEventsPage(input: TokenUsagePageInput) {
  if (!isTokenUsageStorageEnabled()) return createEmptyEventsPage(input)
  return getUsageWorker().execute("getTokenUsageEventsPage", input, Date.now())
}

export async function getTokenUsageSessionsPage(input: TokenUsagePageInput) {
  if (!isTokenUsageStorageEnabled()) {
    return { ...createEmptyEventsPage(input), items: [] }
  }
  return getUsageWorker().execute(
    "getTokenUsageSessionsPage",
    input,
    Date.now(),
  )
}

// The worker serializes these database operations. Callers use the exports above.
export const usageDatabaseOperations: UsageDatabaseOperations = {
  writeTokenUsageEvent,
  writeTokenUsageTiming,
  getTokenUsageSummary: queryTokenUsageSummary,
  getTokenUsageDailySummary: queryTokenUsageDailySummary,
  getTokenUsageEventsPage: queryTokenUsageEventsPage,
  getTokenUsageSessionsPage: queryTokenUsageSessionsPage,
  pruneTokenUsageEvents: deleteExpiredUsageEvents,
  closeUsageDatabase,
  flushApiKeyQuotas: persistApiKeyQuotas,
  readQuotaBuckets,
  getVideoUsageJob: async (provider, requestId) =>
    readVideoUsageJob(await getUsageDb(), provider, requestId),
  saveVideoUsageJob: async (job) =>
    writeVideoUsageJobRow(await getUsageDb(), job),
  getDueVideoUsageJobs: async (provider, now, limit) =>
    queryDueVideoUsageJobRows(await getUsageDb(), provider, now, limit),
  deferVideoUsageJob: async (job, nextPollAt) =>
    updateVideoUsageJobPollRow(await getUsageDb(), job, nextPollAt),
  stopPollingVideoUsageJob: async (job) =>
    clearVideoUsageJobPollRow(await getUsageDb(), job),
}
