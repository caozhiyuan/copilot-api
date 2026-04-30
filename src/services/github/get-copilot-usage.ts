import { getGitHubApiBaseUrl, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export type CopilotAccountType = "individual" | "business" | "enterprise"

export const getCopilotUsage = async (
  githubToken?: string,
): Promise<CopilotUsageResponse> => {
  const resolvedGithubToken = githubToken ?? state.githubToken
  if (!resolvedGithubToken) {
    throw new Error("GitHub token not found")
  }

  const authState = { ...state, githubToken: resolvedGithubToken }
  const response = await fetch(
    `${getGitHubApiBaseUrl()}/copilot_internal/user`,
    {
      headers: githubHeaders(authState),
    },
  )

  if (!response.ok) {
    throw new HTTPError("Failed to get Copilot usage", response)
  }

  return (await response.json()) as CopilotUsageResponse
}

export const getCopilotAccountType = async (
  githubToken?: string,
): Promise<CopilotAccountType> => {
  const usage = await getCopilotUsage(githubToken)
  const plan = (usage.copilot_plan ?? "").toLowerCase()

  if (plan.includes("enterprise")) return "enterprise"
  if (plan.includes("business")) return "business"
  return "individual"
}

export interface QuotaDetail {
  entitlement: number
  overage_count: number
  overage_permitted: boolean
  percent_remaining: number
  quota_id: string
  quota_remaining: number
  remaining: number
  unlimited: boolean
}

interface QuotaSnapshots {
  chat: QuotaDetail
  completions: QuotaDetail
  premium_interactions: QuotaDetail
}

interface CopilotUsageResponse {
  login: string
  access_type_sku: string
  analytics_tracking_id: string
  assigned_date: string
  can_signup_for_limited: boolean
  chat_enabled: boolean
  copilot_plan?: string
  organization_login_list: Array<unknown>
  organization_list: Array<unknown>
  quota_reset_date: string
  quota_snapshots: QuotaSnapshots
  endpoints: {
    api: string
    telemetry: string
  }
}
