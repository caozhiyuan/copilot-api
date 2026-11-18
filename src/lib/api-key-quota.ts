import type { ApiKeyQuotaPeriod } from "./api-key-config"

export interface ApiKeyQuotaBucket {
  api_key_id: string
  period: ApiKeyQuotaPeriod
  period_start_ms: number
  used_cost_nanos: number
}

export function apiKeyQuotaWindow(
  period: ApiKeyQuotaPeriod,
  at = Date.now(),
): { startMs: number; endMs: number | null } {
  if (period === "lifetime") return { startMs: 0, endMs: null }
  const start = new Date(at)
  start.setHours(0, 0, 0, 0)
  if (period === "month") start.setDate(1)
  const end = new Date(start)
  if (period === "month") end.setMonth(end.getMonth() + 1)
  else end.setDate(end.getDate() + 1)
  return { startMs: start.getTime(), endMs: end.getTime() }
}

export class ApiKeyQuotaLedger {
  private buckets = new Map<string, ApiKeyQuotaBucket>()

  private bucketKey(
    id: string,
    period: ApiKeyQuotaPeriod,
    start: number,
  ): string {
    return JSON.stringify([id, period, start])
  }

  restore(buckets: Array<ApiKeyQuotaBucket>): void {
    this.buckets.clear()
    for (const bucket of buckets) {
      this.buckets.set(
        this.bucketKey(
          bucket.api_key_id,
          bucket.period,
          bucket.period_start_ms,
        ),
        { ...bucket },
      )
    }
  }

  add(id: string, costNanos: number, at: number): void {
    if (!Number.isSafeInteger(costNanos) || costNanos < 0) return
    for (const period of ["day", "month", "lifetime"] as const) {
      const window = apiKeyQuotaWindow(period, at)
      const key = this.bucketKey(id, period, window.startMs)
      const bucket = this.buckets.get(key) ?? {
        api_key_id: id,
        period,
        period_start_ms: window.startMs,
        used_cost_nanos: 0,
      }
      bucket.used_cost_nanos += costNanos
      this.buckets.set(key, bucket)
    }
  }

  used(id: string, period: ApiKeyQuotaPeriod, at = Date.now()): number {
    return (
      this.buckets.get(
        this.bucketKey(id, period, apiKeyQuotaWindow(period, at).startMs),
      )?.used_cost_nanos ?? 0
    )
  }

  snapshot(): Array<ApiKeyQuotaBucket> {
    return [...this.buckets.values()].map((bucket) => ({ ...bucket }))
  }
}
