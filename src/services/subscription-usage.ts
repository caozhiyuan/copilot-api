import { z } from "zod"
import os from "node:os"

import { getGrokBuildVersion } from "~/lib/grok-build"
import { XAI_API_BASE_URL } from "~/lib/oauth/xai"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { readXaiCredentials } from "~/lib/xai-token"
import { isGitHubCopilotEnabled } from "~/lib/github-copilot-provider"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"
import { resolveProviderEndpointUrl } from "~/services/providers/provider-proxy"
import type {
  SubscriptionProvider,
  SubscriptionQuotaWindow,
  SubscriptionUsage,
} from "~/lib/types/subscription-usage"
import {
  buildCodexRequestHeaders,
  CODEX_API_BASE_URL,
} from "~/services/codex/create-responses"

// Published @openai/codex stable version, checked on 2026-10-25.
const CODEX_CLI_VERSION = "0.164.0"

const amount = z
  .union([
    z.number().finite(),
    z
      .string()
      .trim()
      .min(1)
      .refine((value) => Number.isFinite(Number(value))),
  ])
  .transform(Number)
const number = z.number().finite()
const codexWindow = z.object({
  used_percent: number,
  limit_window_seconds: number.nullish(),
  reset_at: number.nullish(),
  reset_after_seconds: number.nullish(),
})
const codexRateLimit = z.object({
  allowed: z.boolean().nullish(),
  limit_reached: z.boolean().nullish(),
  primary_window: codexWindow.nullish(),
  secondary_window: codexWindow.nullish(),
})
// Source: openai/codex codex-rs/codex-backend-openapi-models/src/models/.
const codexUsage = z.object({
  plan_type: z.string(),
  rate_limit: codexRateLimit.nullish(),
  additional_rate_limits: z
    .array(
      z.object({
        limit_name: z.string(),
        metered_feature: z.string(),
        rate_limit: codexRateLimit.nullish(),
      }),
    )
    .nullish(),
  credits: z
    .object({
      has_credits: z.boolean(),
      unlimited: z.boolean(),
      balance: amount.nullish(),
    })
    .nullish(),
  spend_control: z
    .object({
      reached: z.boolean(),
      individual_limit: z
        .object({
          limit: amount,
          used: amount,
          used_percent: number,
          reset_at: number.nullish(),
          reset_after_seconds: number.nullish(),
        })
        .nullish(),
    })
    .nullish(),
  rate_limit_reached_type: z.object({ type: z.string() }).nullish(),
})

// Grok Build extensions/billing.rs: proto3 JSON encodes zero cents as {}.
const cents = z.object({ val: amount.default(0) }).nullish()
const xaiUsage = z.object({
  config: z
    .object({
      creditUsagePercent: number.nullish(),
      currentPeriod: z
        .object({
          type: z.string().nullish(),
          end: z.string().nullish(),
        })
        .nullish(),
      monthlyLimit: cents,
      used: cents,
      onDemandCap: cents,
      onDemandUsed: cents,
      prepaidBalance: cents,
      billingPeriodEnd: z.string().nullish(),
    })
    .nullish(),
  subscription_tier: z.string().nullish(),
})

const copilotQuota = z.object({
  entitlement: number.nullish(),
  remaining: number.nullish(),
  quota_remaining: number.nullish(),
  percent_remaining: number.nullish(),
  unlimited: z.boolean().nullish(),
})
const copilotUsage = z.object({
  copilot_plan: z.string().nullish(),
  quota_reset_date: z.string().nullish(),
  quota_snapshots: z
    .object({
      premium_interactions: copilotQuota.nullish(),
      chat: copilotQuota.nullish(),
      completions: copilotQuota.nullish(),
    })
    .nullish(),
})

// OpenCode's Go usage API reports percentages and ISO reset times, not dollars.
// Source: anomalyco/opencode packages/core/src/usage-limits.ts (GoUsage).
const opencodeGoWindow = z.object({
  status: z.enum(["ok", "rate-limited"]),
  percent: number,
  resetsAt: z.string().nullish(),
})
const opencodeGoUsage = z.object({
  usage: z.object({
    rolling: opencodeGoWindow.nullish(),
    weekly: opencodeGoWindow.nullish(),
    monthly: opencodeGoWindow.nullish(),
  }),
})

export function normalizeOpencodeGoUsage(value: unknown): SubscriptionUsage {
  const { usage } = opencodeGoUsage.parse(value)
  const windows: Array<SubscriptionQuotaWindow> = []
  for (const scope of ["rolling", "weekly", "monthly"] as const) {
    const window = usage[scope]
    if (!window) continue
    windows.push({
      id: `opencode-go:${scope}`,
      kind: "usage",
      windowSeconds: scope === "rolling" ? 18000 : undefined,
      period: scope === "rolling" ? undefined : scope,
      usedPercent: window.percent,
      resetAt: parseResetDate(window.resetsAt),
      limitReached: window.status === "rate-limited" || window.percent >= 100,
    })
  }
  return {
    provider: "opencode-go",
    windows,
    limitReached: windows.some((window) => window.limitReached),
  }
}

export function normalizeCopilotUsage(value: unknown): SubscriptionUsage {
  const usage = copilotUsage.parse(value)
  const windows: Array<SubscriptionQuotaWindow> = []
  const labels = {
    premium_interactions: "Premium",
    chat: "Chat",
    completions: "Completions",
  }
  for (const id of ["premium_interactions", "chat", "completions"] as const) {
    const quota = usage.quota_snapshots?.[id]
    if (!quota) continue
    const remaining = quota.remaining ?? quota.quota_remaining
    const limit = quota.entitlement ?? undefined
    const remainingPercent =
      quota.percent_remaining
      ?? (limit !== undefined && limit > 0 && remaining != null ?
        (remaining / limit) * 100
      : undefined)
    if (
      !quota.unlimited
      && remainingPercent == null
      && remaining == null
      && limit === undefined
    )
      continue
    windows.push({
      id: `copilot:${id}`,
      kind: "usage",
      name: labels[id],
      unlimited: quota.unlimited ?? false,
      usedPercent:
        quota.unlimited || remainingPercent == null ?
          undefined
        : 100 - remainingPercent,
      used:
        limit !== undefined && remaining != null ?
          Math.max(0, limit - remaining)
        : undefined,
      limit,
      unit: "requests",
      resetDate: usage.quota_reset_date ?? undefined,
      limitReached:
        !quota.unlimited && remainingPercent != null && remainingPercent <= 0,
    })
  }
  return {
    provider: "github-copilot",
    planType: usage.copilot_plan ?? undefined,
    windows,
    limitReached: windows.some((window) => window.limitReached),
  }
}

function resetAt(
  window: { reset_at?: number | null; reset_after_seconds?: number | null },
  now: number,
): number | undefined {
  return (
    window.reset_at
    ?? (window.reset_after_seconds == null ?
      undefined
    : Math.floor(now / 1000) + window.reset_after_seconds)
  )
}

export function normalizeCodexUsage(
  value: unknown,
  now = Date.now(),
): SubscriptionUsage {
  const usage = codexUsage.parse(value)
  const windows: Array<SubscriptionQuotaWindow> = []
  const addWindows = (
    id: string,
    limits: z.infer<typeof codexRateLimit> | null | undefined,
    name?: string,
  ) => {
    for (const scope of ["primary_window", "secondary_window"] as const) {
      const window = limits?.[scope]
      if (!window) continue
      windows.push({
        id: `${id}:${scope}`,
        kind: "usage",
        name,
        usedPercent: window.used_percent,
        windowSeconds: window.limit_window_seconds ?? undefined,
        resetAt: resetAt(window, now),
        limitReached:
          limits?.limit_reached === true || limits?.allowed === false,
      })
    }
  }
  addWindows("codex", usage.rate_limit)
  for (const [index, limit] of (usage.additional_rate_limits ?? []).entries()) {
    addWindows(
      `${limit.metered_feature}:${index}`,
      limit.rate_limit,
      limit.limit_name,
    )
  }
  const spend = usage.spend_control?.individual_limit
  if (spend) {
    windows.push({
      id: "individual-limit",
      kind: "spend",
      period: "monthly",
      usedPercent: spend.used_percent,
      used: spend.used,
      limit: spend.limit,
      unit: "credits",
      resetAt: resetAt(spend, now),
      limitReached: usage.spend_control?.reached,
    })
  }
  return {
    provider: "codex",
    planType: usage.plan_type,
    windows,
    credits:
      usage.credits ?
        {
          balance: usage.credits.balance ?? undefined,
          unlimited: usage.credits.unlimited,
          hasCredits: usage.credits.has_credits,
          unit: "credits",
        }
      : undefined,
    limitReached:
      usage.rate_limit?.limit_reached === true
      || usage.rate_limit?.allowed === false
      || usage.spend_control?.reached === true
      || (usage.rate_limit_reached_type != null
        && usage.rate_limit_reached_type.type !== "unknown"),
    limitReason: usage.rate_limit_reached_type?.type,
  }
}

function parseResetDate(value: string | null | undefined): number | undefined {
  const milliseconds = value ? Date.parse(value) : NaN
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : undefined
}

export function normalizeXaiUsage(value: unknown): SubscriptionUsage {
  const usage = xaiUsage.parse(value)
  const config = usage.config
  const windows: Array<SubscriptionQuotaWindow> = []
  if (config) {
    const limit = config.monthlyLimit?.val
    const used = config.used?.val
    const usedPercent =
      config.creditUsagePercent
      ?? (limit !== undefined && limit > 0 && used !== undefined ?
        (used / limit) * 100
      : undefined)
    if (usedPercent != null || limit !== undefined || used !== undefined) {
      windows.push({
        id: "included",
        kind: "usage",
        period:
          config.currentPeriod?.type === "USAGE_PERIOD_TYPE_WEEKLY" ? "weekly"
          : (
            config.currentPeriod?.type === "USAGE_PERIOD_TYPE_MONTHLY"
            || config.monthlyLimit
          ) ?
            "monthly"
          : undefined,
        usedPercent,
        // New credits-config percentages supersede the deprecated dollar budget.
        used:
          config.creditUsagePercent == null && used !== undefined ?
            used / 100
          : undefined,
        limit:
          config.creditUsagePercent == null && limit !== undefined ?
            limit / 100
          : undefined,
        unit: "USD",
        resetAt: parseResetDate(
          config.currentPeriod?.end ?? config.billingPeriodEnd,
        ),
      })
    }
    if (config.onDemandCap || config.onDemandUsed) {
      const cap = Math.abs(config.onDemandCap?.val ?? 0)
      const spent = Math.abs(config.onDemandUsed?.val ?? 0)
      windows.push({
        id: "on-demand",
        kind: "on-demand",
        period: "monthly",
        unit: "USD",
        used: spent / 100,
        limit: cap / 100,
        usedPercent: cap > 0 ? (spent / cap) * 100 : undefined,
      })
    }
  }
  return {
    provider: "xai",
    planType: usage.subscription_tier ?? undefined,
    windows,
    credits:
      config?.prepaidBalance ?
        {
          balance: Math.abs(config.prepaidBalance.val) / 100,
          unlimited: false,
          hasCredits: config.prepaidBalance.val !== 0,
          unit: "USD",
        }
      : undefined,
    limitReached:
      (windows.find((window) => window.id === "included")?.usedPercent ?? 0)
      >= 100,
  }
}

export async function getSubscriptionUsage(
  provider: SubscriptionProvider,
  signal?: AbortSignal,
): Promise<SubscriptionUsage | null> {
  if (provider === "github-copilot") {
    if (!isGitHubCopilotEnabled()) return null
    const timeout = AbortSignal.timeout(15_000)
    const usage = await getCopilotUsage(
      undefined,
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    )
    return usage ? normalizeCopilotUsage(usage) : null
  }
  const config = await resolveProviderConfig(provider)
  if (!config) return null
  if (provider !== "opencode-go" && config.authType !== "oauth2") return null

  let headers: Headers
  let url: string
  if (provider === "opencode-go") {
    url = resolveProviderEndpointUrl(config, "usage")
    headers = new Headers({
      Authorization: `Bearer ${config.apiKey}`,
      Accept: "application/json",
    })
  } else if (provider === "codex") {
    // Match codex-login's default_client UA format and backend account scoping.
    const platform =
      process.platform === "win32" ? "Windows"
      : process.platform === "darwin" ? "Mac OS"
      : os.type()
    const arch =
      process.arch === "x64" ? "x86_64"
      : process.arch === "arm64" ? "aarch64"
      : process.arch
    headers = buildCodexRequestHeaders(
      new Headers({
        "user-agent": `codex_cli_rs/${CODEX_CLI_VERSION} (${platform} ${os.release()}; ${arch}) unknown`,
        originator: "codex_cli_rs",
        accept: "application/json",
      }),
    )
    url = `${CODEX_API_BASE_URL}/wham/usage`
  } else {
    const credentials = await readXaiCredentials()
    if (!credentials) return null
    if (credentials.accessToken !== config.apiKey) {
      throw new Error("Subscription account changed during the usage query")
    }
    const version = await getGrokBuildVersion()
    const platform =
      process.platform === "win32" ? "windows"
      : process.platform === "darwin" ? "macos"
      : process.platform
    const arch =
      process.arch === "x64" ? "x86_64"
      : process.arch === "arm64" ? "aarch64"
      : process.arch
    headers = new Headers({
      Authorization: `Bearer ${config.apiKey}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-userid": credentials.accountId,
      "x-grok-client-version": version,
      "x-grok-client-mode": "headless",
      "User-Agent": `grok-shell/${version} (${platform}; ${arch})`,
      Accept: "application/json",
    })
    url = `${XAI_API_BASE_URL}/v1/billing?format=credits`
  }
  const timeout = AbortSignal.timeout(15_000)
  const response = await fetch(url, {
    headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: "error",
  })
  // OpenCode's usage client treats 403 as a workspace without a Go allowance.
  if (provider === "opencode-go" && response.status === 403) {
    await response.body?.cancel()
    return null
  }
  if (!response.ok) {
    await response.body?.cancel()
    // Never expose the upstream body: it can contain account details.
    throw new Error(
      `Subscription usage request failed (HTTP ${response.status})`,
    )
  }
  const value: unknown = await response.json()
  if (provider === "opencode-go") return normalizeOpencodeGoUsage(value)
  return provider === "codex" ?
      normalizeCodexUsage(value)
    : normalizeXaiUsage(value)
}
