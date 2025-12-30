import { Hono, type Context } from "hono"

import { accountsManager } from "~/lib/accounts-manager"
import { listAccountsFromRegistry } from "~/lib/accounts-registry"
import {
  getRequestHistoryStore,
  type AccountStatsRow,
} from "~/lib/request-history"

const ADMIN_TOKEN = process.env.ADMIN_TOKEN?.trim() || undefined

type AdminAccessDecision =
  | { ok: true }
  | {
      ok: false
      status: 401 | 403
      message: string
      errorType: "unauthorized" | "forbidden"
    }

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "0.0.0.0"
  )
}

function getBearerToken(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed.toLowerCase().startsWith("bearer ")) return undefined
  return trimmed.slice("bearer ".length).trim() || undefined
}

function getRequestAdminToken(c: Context): string | undefined {
  const headerToken = c.req.header("x-admin-token")?.trim()
  if (headerToken) return headerToken

  const bearer = c.req.header("authorization")
  if (bearer) {
    const token = getBearerToken(bearer)
    if (token) return token
  }

  const url = new URL(c.req.url, "http://local")
  const queryToken = url.searchParams.get("admin_token")?.trim()
  return queryToken || undefined
}

function isSameOrigin(requestUrl: URL, originHeader: string): boolean {
  try {
    return new URL(originHeader).origin === requestUrl.origin
  } catch {
    return false
  }
}

function decideAdminAccess(c: Context): AdminAccessDecision {
  const url = new URL(c.req.url, "http://local")

  const token = getRequestAdminToken(c)
  const tokenOk = Boolean(ADMIN_TOKEN) && token === ADMIN_TOKEN

  const origin = c.req.header("origin")
  if (origin && !tokenOk && !isSameOrigin(url, origin)) {
    return {
      ok: false,
      status: 403,
      message: "Cross-origin access to admin API is forbidden.",
      errorType: "forbidden",
    }
  }

  const loopback = isLoopbackHostname(url.hostname)
  if (loopback || tokenOk) {
    return { ok: true }
  }

  if (ADMIN_TOKEN) {
    return {
      ok: false,
      status: 401,
      message:
        "Admin API requires x-admin-token or Authorization: Bearer <token>.",
      errorType: "unauthorized",
    }
  }

  return {
    ok: false,
    status: 403,
    message:
      "Admin API is only available on localhost. Set ADMIN_TOKEN to enable remote access.",
    errorType: "forbidden",
  }
}

type AccountItem = {
  account_id: string
  account_type?: string
  runtime: {
    remaining?: number
    unlimited?: boolean
    failed?: boolean
    failureReason?: string
  }
  stats?: {
    since_ms: number
    request_count?: number
    error_count?: number
    tokens_total?: number
    avg_duration_ms?: number
    last_request_at_ms?: number
  }
}

function parseFiniteNumber(value: string | null): number | undefined {
  if (!value) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function parseTriStateBool(value: string | null): boolean | undefined {
  if (value === "1") return true
  if (value === "0") return false
  return undefined
}

export const adminApiRoutes = new Hono()

adminApiRoutes.use("*", async (c, next) => {
  const decision = decideAdminAccess(c)
  if (!decision.ok) {
    return c.json(
      {
        error: {
          message: decision.message,
          type: decision.errorType,
        },
      },
      decision.status,
    )
  }

  await next()
})

adminApiRoutes.get("/meta", (c) => {
  const store = getRequestHistoryStore()
  return c.json(store.meta())
})

adminApiRoutes.get("/accounts", async (c) => {
  const url = new URL(c.req.url, "http://local")
  const sinceMs = Number(url.searchParams.get("since_ms") ?? "")
  const includeStats = url.searchParams.get("include_stats") !== "0"

  const since =
    Number.isFinite(sinceMs) && sinceMs > 0 ?
      sinceMs
    : Date.now() - 24 * 60 * 60 * 1000

  const registry = await listAccountsFromRegistry().catch(() => [])
  const registryTypeById = new Map(registry.map((a) => [a.id, a.accountType]))

  const statuses = accountsManager.getAccountStatus()

  const store = getRequestHistoryStore()
  const statsByAccount: Record<string, AccountStatsRow | undefined> =
    includeStats ? store.getAccountStatsSince(since) : {}

  const items: Array<AccountItem> = statuses.map((s) => {
    const accountType = registryTypeById.get(s.id)
    const statsRow = includeStats ? statsByAccount[s.id] : undefined

    const stats =
      includeStats ?
        {
          since_ms: since,
          request_count: statsRow?.request_count,
          error_count: statsRow?.error_count,
          tokens_total: statsRow?.tokens_total,
          avg_duration_ms: statsRow?.avg_duration_ms,
          last_request_at_ms: statsRow?.last_request_at_ms,
        }
      : undefined

    return {
      account_id: s.id,
      account_type: accountType,
      runtime: {
        remaining: s.remaining,
        unlimited: s.unlimited,
        failed: s.failed,
        failureReason: s.failureReason,
      },
      stats,
    }
  })

  return c.json({ items })
})

adminApiRoutes.get("/requests", (c) => {
  const url = new URL(c.req.url, "http://local")
  const p = url.searchParams

  const limit = parseFiniteNumber(p.get("limit")) ?? 50
  const cursorId = parseFiniteNumber(p.get("cursor_id"))

  const status = parseFiniteNumber(p.get("status"))
  const hasError = parseTriStateBool(p.get("has_error"))

  const fromMs = parseFiniteNumber(p.get("from_ms"))
  const toMs = parseFiniteNumber(p.get("to_ms"))

  const store = getRequestHistoryStore()
  const result = store.query({
    limit,
    cursorId,

    accountId: p.get("account_id") || undefined,
    upstreamModel: p.get("upstream_model") || undefined,
    clientModel: p.get("client_model") || undefined,
    upstreamEndpoint: p.get("upstream_endpoint") || undefined,
    path: p.get("path") || undefined,

    status,
    hasError,
    fromMs,
    toMs,
  })

  return c.json({
    items: result.items,
    next_cursor_id: result.nextCursorId,
    has_more: result.hasMore,
  })
})

adminApiRoutes.get("/requests/:requestId", (c) => {
  const requestId = c.req.param("requestId")
  const store = getRequestHistoryStore()
  const item = store.getByRequestId(requestId)
  return c.json({ item })
})
