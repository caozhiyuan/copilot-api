export type SubscriptionProvider = "codex" | "xai"

export interface SubscriptionQuotaWindow {
  id: string
  kind: "usage" | "spend" | "on-demand"
  name?: string
  period?: "weekly" | "monthly"
  windowSeconds?: number
  usedPercent?: number
  resetAt?: number
  used?: number
  limit?: number
  unit?: "credits" | "USD"
  limitReached?: boolean
}

export interface SubscriptionUsage {
  provider: SubscriptionProvider
  planType?: string
  windows: Array<SubscriptionQuotaWindow>
  credits?: {
    balance?: number
    unlimited: boolean
    hasCredits: boolean
    unit: "credits" | "USD"
  }
  limitReached: boolean
  limitReason?: string
}
