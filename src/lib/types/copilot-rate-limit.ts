export type CopilotRateLimitType = "session" | "weekly"

export interface CopilotRateLimitUsage {
  type: CopilotRateLimitType
  remaining: string
  resetAt: string
}

export interface CopilotQuotaSnapshot {
  entitlement: string
  percent_remaining: number
  overage_permitted: boolean
  overage_count: number
  reset_date: string
}
