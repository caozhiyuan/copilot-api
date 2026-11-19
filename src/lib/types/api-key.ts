export type ApiKeyQuotaPeriod = "day" | "month" | "lifetime"

export interface GatewayApiKeyConfig {
  id: string
  key: string
  name?: string
  enabled?: boolean
  expiresAt?: string
  allowedModels?: Array<string>
  quota?: {
    period: ApiKeyQuotaPeriod
    amount: number
  }
}

export interface ApiKeyQuotaUsage {
  id: string
  usedAmount: number
  remainingAmount: number | null
  resetsAt: number | null
}
