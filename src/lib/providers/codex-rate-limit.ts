import consola from "consola"

const codexRateLimitScopes = ["primary", "secondary"] as const

interface CodexRateLimitWindow {
  reset_after_seconds: number
  reset_at: number
  used_percent: number
  window_minutes: number
}

export const formatCodexRateLimitResetAt = (resetAt: number): string => {
  const date = new Date(resetAt * 1000)
  return Number.isNaN(date.getTime()) ? String(resetAt) : date.toLocaleString()
}

export const logCodexRateLimitsEvent = (event: unknown): void => {
  if (!event || typeof event !== "object") {
    return
  }

  const eventRecord = event as Record<string, unknown>
  if (eventRecord.type !== "codex.rate_limits") {
    return
  }

  const rateLimits = eventRecord.rate_limits
  if (!rateLimits || typeof rateLimits !== "object") {
    return
  }

  const planType =
    typeof eventRecord.plan_type === "string" ? eventRecord.plan_type : null
  const rateLimitRecord = rateLimits as Record<string, unknown>
  const allowed =
    typeof rateLimitRecord.allowed === "boolean" ?
      rateLimitRecord.allowed
    : null
  const limitReached =
    typeof rateLimitRecord.limit_reached === "boolean" ?
      rateLimitRecord.limit_reached
    : null

  for (const scope of codexRateLimitScopes) {
    const window = rateLimitRecord[scope]
    if (!isCodexRateLimitWindow(window)) {
      continue
    }

    const summary: Array<string> = []
    if (allowed !== null) {
      summary.push(`allowed=${allowed}`)
    }
    if (limitReached !== null) {
      summary.push(`limit_reached=${limitReached}`)
    }
    summary.push(
      `used=${window.used_percent}%`,
      `reset_at=${formatCodexRateLimitResetAt(window.reset_at)}`,
    )

    const label =
      planType ?
        `Codex ${scope} rate limit (${planType})`
      : `Codex ${scope} rate limit`
    consola.log(`${label}: ${summary.join(", ")}`)
  }
}

const isCodexRateLimitWindow = (
  value: unknown,
): value is CodexRateLimitWindow => {
  if (!value || typeof value !== "object") {
    return false
  }

  const record = value as Record<string, unknown>
  return (
    typeof record.reset_after_seconds === "number"
    && typeof record.reset_at === "number"
    && typeof record.used_percent === "number"
    && typeof record.window_minutes === "number"
  )
}
