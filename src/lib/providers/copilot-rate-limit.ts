import consola from "consola"

import type {
  CopilotQuotaSnapshot,
  CopilotRateLimitType,
  CopilotRateLimitUsage,
} from "../types/copilot-rate-limit"

export type {
  CopilotQuotaSnapshot,
  CopilotRateLimitType,
  CopilotRateLimitUsage,
} from "../types/copilot-rate-limit"

const copilotRateLimitTypes = ["session", "weekly"] as const

type HeadersMap = Record<string, string | undefined>
type HeadersLike = Headers | HeadersMap
type QuotaSnapshotMap = Record<string, unknown>

const copilotRateLimitHeaders: Record<CopilotRateLimitType, string> = {
  session: "x-usage-ratelimit-session",
  weekly: "x-usage-ratelimit-weekly",
}

const copilotQuotaSnapshotKeys: Record<CopilotRateLimitType, string> = {
  session: "5Hour-Session-RateLimits",
  weekly: "Weekly-Session-RateLimits",
}

const hasGetMethod = (headers: HeadersLike): headers is Headers => {
  return "get" in headers && typeof headers.get === "function"
}

const getHeaderValue = (
  headers: HeadersLike,
  headerName: string,
): string | null => {
  if (hasGetMethod(headers)) {
    return headers.get(headerName)
  }

  const normalizedHeaderName = headerName.toLowerCase()
  const matchedEntry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === normalizedHeaderName,
  )

  return matchedEntry?.[1] ?? null
}

export const parseCopilotRateLimitHeader = (
  headerValue: string,
): Omit<CopilotRateLimitUsage, "type"> | null => {
  const params = new URLSearchParams(headerValue)
  const remaining = params.get("rem")
  const resetAt = params.get("rst")

  if (!remaining || !resetAt) {
    return null
  }

  return {
    remaining,
    resetAt,
  }
}

export const getCopilotRateLimitUsage = (
  headers: HeadersLike,
  type: CopilotRateLimitType,
): CopilotRateLimitUsage | null => {
  const headerName = copilotRateLimitHeaders[type]
  const headerValue = getHeaderValue(headers, headerName)

  if (!headerValue) {
    return null
  }

  const parsed = parseCopilotRateLimitHeader(headerValue)

  if (!parsed) {
    return null
  }

  return {
    type,
    ...parsed,
  }
}

export const getCopilotRateLimitUsageFromSnapshots = (
  snapshots: QuotaSnapshotMap | undefined,
  type: CopilotRateLimitType,
): CopilotRateLimitUsage | null => {
  const snapshot = snapshots?.[copilotQuotaSnapshotKeys[type]]
  if (!isCopilotQuotaSnapshot(snapshot)) {
    return null
  }

  return {
    remaining: String(snapshot.percent_remaining),
    resetAt: snapshot.reset_date,
    type,
  }
}

export const logCopilotRateLimits = (headers: HeadersLike): void => {
  for (const type of copilotRateLimitTypes) {
    const usage = getCopilotRateLimitUsage(headers, type)

    if (!usage) {
      continue
    }

    logCopilotRateLimitUsage(usage)
  }
}

export const logCopilotQuotaSnapshots = (
  snapshots: QuotaSnapshotMap | undefined,
): void => {
  for (const type of copilotRateLimitTypes) {
    const usage = getCopilotRateLimitUsageFromSnapshots(snapshots, type)

    if (!usage) {
      continue
    }

    logCopilotRateLimitUsage(usage)
  }
}

const logCopilotRateLimitUsage = (usage: CopilotRateLimitUsage): void => {
  const d = new Date(usage.resetAt)
  const dateStr = Number.isNaN(d.getTime()) ? usage.resetAt : d.toLocaleString()
  consola.log(
    `Copilot ${usage.type} quota remaining: ${usage.remaining}, resets at: ${dateStr}`,
  )
}

const isCopilotQuotaSnapshot = (
  value: unknown,
): value is CopilotQuotaSnapshot => {
  if (!value || typeof value !== "object") {
    return false
  }

  const record = value as Record<string, unknown>
  return (
    typeof record.entitlement === "string"
    && typeof record.percent_remaining === "number"
    && typeof record.overage_permitted === "boolean"
    && typeof record.overage_count === "number"
    && typeof record.reset_date === "string"
  )
}
