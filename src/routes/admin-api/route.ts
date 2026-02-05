import { Hono, type Context } from "hono"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import { accountsManager } from "~/lib/accounts-manager"
import { listAccountsFromRegistry } from "~/lib/accounts-registry"
import {
  getConfig,
  getModelAliases,
  isFreeModelLoadBalancingEnabled,
  mergeConfigWithDefaults,
  type AppConfig,
} from "~/lib/config"
import { PATHS } from "~/lib/paths"
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
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  )
}

function getBearerToken(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed.toLowerCase().startsWith("bearer ")) return undefined
  const token = trimmed.slice("bearer ".length).trim()
  return token || undefined
}

function getRequestAdminToken(c: Context): string | undefined {
  const headerToken = c.req.header("x-admin-token")?.trim()
  if (headerToken) return headerToken

  const bearer = c.req.header("authorization")
  if (bearer) {
    return getBearerToken(bearer)
  }

  return undefined
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

  if (isLoopbackHostname(url.hostname) || tokenOk) {
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
    entitlement?: number
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

type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

type ConfigErrorType = "bad_request" | "internal_error"

type ConfigErrorPayload = {
  message: string
  type: ConfigErrorType
}

const CONFIG_KEYS = new Set<keyof AppConfig>([
  "extraPrompts",
  "smallModel",
  "freeModelLoadBalancing",
  "apiKey",
  "modelReasoningEfforts",
  "modelAliases",
  "allowOriginalModelNamesForAliases",
  "useFunctionApplyPatch",
  "forceAgent",
  "compactUseSmallModel",
  "messageStartInputTokensFallback",
])

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
])

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"])

function jsonError(
  c: Context,
  status: 400 | 500,
  error: ConfigErrorPayload,
): Response {
  return c.json(
    {
      error,
    },
    status,
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type ParseFieldResult<T> = { clear: true } | { value: T } | { error: string }

function parseOptionalString(
  value: unknown,
  field: string,
): ParseFieldResult<string> {
  if (value === null || value === undefined) return { clear: true }
  if (typeof value !== "string") return { error: `${field} must be a string` }

  const trimmed = value.trim()
  if (!trimmed) return { clear: true }

  return { value: trimmed }
}

function parseOptionalBoolean(
  value: unknown,
  field: string,
): ParseFieldResult<boolean> {
  if (value === null || value === undefined) return { clear: true }
  if (typeof value !== "boolean") return { error: `${field} must be a boolean` }
  return { value }
}

function parseStringRecord(
  value: unknown,
  field: string,
): ParseFieldResult<Record<string, string>> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: `${field} must be an object with string values` }
  }

  const record = Object.create(null) as Record<string, string>
  for (const [key, entry] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(key)) {
      return { error: `${field}.${key} is not allowed` }
    }
    if (typeof entry !== "string") {
      return { error: `${field}.${key} must be a string` }
    }
    record[key] = entry
  }

  return { value: record }
}

function parseReasoningRecord(
  value: unknown,
): ParseFieldResult<Record<string, ReasoningEffort>> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: "modelReasoningEfforts must be an object" }
  }

  const record = Object.create(null) as Record<string, ReasoningEffort>
  for (const [model, effort] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(model)) {
      return { error: `modelReasoningEfforts.${model} is not allowed` }
    }
    if (typeof effort !== "string") {
      return { error: `modelReasoningEfforts.${model} must be a string` }
    }
    if (!REASONING_EFFORTS.has(effort as ReasoningEffort)) {
      return {
        error: `modelReasoningEfforts.${model} must be one of ${[
          ...REASONING_EFFORTS,
        ].join(", ")}`,
      }
    }
    record[model] = effort as ReasoningEffort
  }

  return { value: record }
}

type ParsedModelAlias = {
  alias: string
  target: string
  allowOriginal?: boolean
}

function parseModelAliasEntry(
  rawAlias: string,
  rawTarget: unknown,
): ParseFieldResult<ParsedModelAlias> {
  if (BLOCKED_KEYS.has(rawAlias)) {
    return { error: `modelAliases.${rawAlias} is not allowed` }
  }

  const alias = rawAlias.trim().toLowerCase()
  if (!alias) {
    return { error: "modelAliases keys must be non-empty strings" }
  }
  if (BLOCKED_KEYS.has(alias)) {
    return { error: `modelAliases.${alias} is not allowed` }
  }

  let target: string | undefined
  let allowOriginal: boolean | undefined

  if (typeof rawTarget === "string") {
    target = rawTarget.trim()
  } else if (isPlainObject(rawTarget)) {
    const rawTargetValue = rawTarget.target
    if (typeof rawTargetValue !== "string") {
      return { error: `modelAliases.${rawAlias}.target must be a string` }
    }
    target = rawTargetValue.trim()

    if ("allowOriginal" in rawTarget) {
      if (typeof rawTarget.allowOriginal !== "boolean") {
        return {
          error: `modelAliases.${rawAlias}.allowOriginal must be a boolean`,
        }
      }
      allowOriginal = rawTarget.allowOriginal
    }
  } else {
    return { error: `modelAliases.${rawAlias} must be a string or object` }
  }

  if (!target) {
    return { error: `modelAliases.${rawAlias} must be a non-empty string` }
  }
  if (alias === target.toLowerCase()) {
    return { error: `modelAliases.${rawAlias} cannot map to itself` }
  }

  return { value: { alias, target, allowOriginal } }
}

function parseModelAliases(
  value: unknown,
): ParseFieldResult<
  Record<string, { target: string; allowOriginal?: boolean }>
> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: "modelAliases must be an object" }
  }

  const record = Object.create(null) as Record<
    string,
    { target: string; allowOriginal?: boolean }
  >

  for (const [rawAlias, rawTarget] of Object.entries(value)) {
    const parsed = parseModelAliasEntry(rawAlias, rawTarget)
    if ("error" in parsed) return parsed
    if ("clear" in parsed) continue

    const { alias, target, allowOriginal } = parsed.value
    const existing = Object.hasOwn(record, alias) ? record[alias] : undefined
    if (
      existing
      && (existing.target !== target
        || existing.allowOriginal !== allowOriginal)
    ) {
      return { error: `modelAliases.${rawAlias} conflicts with ${alias}` }
    }

    record[alias] =
      allowOriginal === undefined ? { target } : { target, allowOriginal }
  }

  return { value: record }
}

function applyOptionalString(
  next: AppConfig,
  key: "smallModel" | "apiKey",
  value: unknown,
): string | undefined {
  const parsed = parseOptionalString(value, key)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    next[key] = undefined
    return undefined
  }
  next[key] = parsed.value
  return undefined
}

function applyOptionalBoolean(
  next: AppConfig,
  key:
    | "freeModelLoadBalancing"
    | "useFunctionApplyPatch"
    | "forceAgent"
    | "compactUseSmallModel"
    | "messageStartInputTokensFallback"
    | "allowOriginalModelNamesForAliases",
  value: unknown,
): string | undefined {
  const parsed = parseOptionalBoolean(value, key)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    next[key] = undefined
    return undefined
  }
  next[key] = parsed.value
  return undefined
}

function applyExtraPrompts(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseStringRecord(value, "extraPrompts")
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.extraPrompts
    return undefined
  }
  next.extraPrompts = parsed.value
  return undefined
}

function applyReasoningEfforts(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseReasoningRecord(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.modelReasoningEfforts
    return undefined
  }
  next.modelReasoningEfforts = parsed.value
  return undefined
}

function applyModelAliases(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseModelAliases(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.modelAliases
    return undefined
  }
  next.modelAliases = parsed.value
  return undefined
}

function applyConfigPatch(
  base: AppConfig,
  input: Record<string, unknown>,
): { config?: AppConfig; error?: string } {
  const next: AppConfig = { ...base }

  for (const [rawKey, value] of Object.entries(input)) {
    const key = rawKey as keyof AppConfig
    if (!CONFIG_KEYS.has(key)) {
      return { error: `Unknown config key: ${rawKey}` }
    }

    let error: string | undefined

    switch (rawKey) {
      case "extraPrompts": {
        error = applyExtraPrompts(next, value)
        break
      }
      case "smallModel": {
        error = applyOptionalString(next, "smallModel", value)
        break
      }
      case "freeModelLoadBalancing": {
        error = applyOptionalBoolean(next, "freeModelLoadBalancing", value)
        break
      }
      case "apiKey": {
        error = applyOptionalString(next, "apiKey", value)
        break
      }
      case "modelReasoningEfforts": {
        error = applyReasoningEfforts(next, value)
        break
      }
      case "modelAliases": {
        error = applyModelAliases(next, value)
        break
      }
      case "allowOriginalModelNamesForAliases": {
        error = applyOptionalBoolean(
          next,
          "allowOriginalModelNamesForAliases",
          value,
        )
        break
      }
      case "useFunctionApplyPatch": {
        error = applyOptionalBoolean(next, "useFunctionApplyPatch", value)
        break
      }
      case "forceAgent": {
        error = applyOptionalBoolean(next, "forceAgent", value)
        break
      }
      case "compactUseSmallModel": {
        error = applyOptionalBoolean(next, "compactUseSmallModel", value)
        break
      }
      case "messageStartInputTokensFallback": {
        error = applyOptionalBoolean(
          next,
          "messageStartInputTokensFallback",
          value,
        )
        break
      }
      default: {
        return { error: `Unsupported config key: ${rawKey}` }
      }
    }

    if (error) return { error }
  }

  return { config: next }
}

async function writeConfigFile(config: AppConfig): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })

  const content = `${JSON.stringify(config, null, 2)}\n`
  const tmpPath = `${PATHS.CONFIG_PATH}.tmp-${randomUUID()}`

  try {
    await fs.writeFile(tmpPath, content, "utf8")
    try {
      await fs.chmod(tmpPath, 0o600)
    } catch {
      // Ignore chmod errors (e.g. unsupported filesystem).
    }
    await fs.rename(tmpPath, PATHS.CONFIG_PATH)
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
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

adminApiRoutes.get("/config", (c) => {
  try {
    const config = mergeConfigWithDefaults()
    return c.json({ ...config, _configPath: PATHS.CONFIG_PATH })
  } catch {
    return jsonError(c, 500, {
      message: "Failed to load config.",
      type: "internal_error",
    })
  }
})

adminApiRoutes.post("/config", async (c) => {
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return jsonError(c, 400, {
      message: "Config payload must be valid JSON.",
      type: "bad_request",
    })
  }

  if (!isPlainObject(payload)) {
    return jsonError(c, 400, {
      message: "Config payload must be an object.",
      type: "bad_request",
    })
  }

  const result = applyConfigPatch(getConfig(), payload)
  if (!result.config) {
    return jsonError(c, 400, {
      message: result.error ?? "Invalid config payload.",
      type: "bad_request",
    })
  }

  try {
    await writeConfigFile(result.config)
    const merged = mergeConfigWithDefaults()
    accountsManager.setFreeModelLoadBalancingEnabled(
      isFreeModelLoadBalancingEnabled(),
    )
    return c.json({ ...merged, _configPath: PATHS.CONFIG_PATH })
  } catch {
    return jsonError(c, 500, {
      message: "Failed to write config.",
      type: "internal_error",
    })
  }
})

adminApiRoutes.get("/models", (c) => {
  try {
    const accountModels = accountsManager.getFirstAccountModels()
    const items =
      accountModels?.data
        .map((model) => model.id)
        .filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0,
        ) ?? []
    const aliasItems = Object.keys(getModelAliases())
    const uniqueItems = Array.from(new Set([...items, ...aliasItems])).sort()
    return c.json({ items: uniqueItems })
  } catch {
    return jsonError(c, 500, {
      message: "Failed to load models.",
      type: "internal_error",
    })
  }
})

adminApiRoutes.get("/accounts", async (c) => {
  const url = new URL(c.req.url, "http://local")
  const sinceMs = Number(url.searchParams.get("since_ms") ?? "")
  const includeStats = url.searchParams.get("include_stats") !== "0"

  let since = Date.now() - 24 * 60 * 60 * 1000
  if (Number.isFinite(sinceMs) && sinceMs > 0) {
    since = sinceMs
  }

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
        entitlement: s.entitlement,
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
