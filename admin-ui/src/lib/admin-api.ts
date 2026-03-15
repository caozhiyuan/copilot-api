import { readAdminToken } from "@/lib/admin-token"

export const ADMIN_TOKEN_REQUIRED_EVENT = "admin-ui:admin-token-required"

export type AdminMeta = {
  userVersion?: number
  dbPath?: string
}

export type AdminAccountItem = {
  account_id: string
  account_type?: string
  runtime?: {
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

export type AdminAccountsResponse = {
  items: AdminAccountItem[]
}

export type AdminRequestItem = {
  request_id: string
  started_at_ms?: number
  http_status: number
  duration_ms?: number
  ttfb_ms?: number

  path: string
  upstream_endpoint?: string
  upstream_model?: string
  client_model?: string
  account_id?: string

  // Cost/quota
  cost_units?: number
  premium_unlimited_after?: boolean
  premium_remaining_after?: number
  premium_remaining_before?: number
  premium_remaining_diff?: number

  // Token usage
  tokens_input?: number
  tokens_output?: number
  tokens_total?: number
  tokens_cached_input?: number

  // Client info
  client_ip?: string
  user_agent?: string

  // Session correlation
  user_id?: string
  safety_identifier?: string
  prompt_cache_key?: string
  initiator?: string
  upstream_request_id?: string

  // Optional error info (depends on store)
  error?: unknown
}

export type AdminRequestsResponse = {
  items: AdminRequestItem[]
  next_cursor_id?: number | null
  has_more: boolean
}

export type AdminRequestDetailResponse = {
  item: AdminRequestItem | null
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

export type ModelAliasSpec = {
  target: string
  allowOriginal?: boolean
}

export type ProviderModelConfig = {
  temperature?: number
  topP?: number
  topK?: number
}

export type ProviderConfig = {
  type?: string
  enabled?: boolean
  baseUrl?: string
  apiKey?: string
  models?: Record<string, ProviderModelConfig>
}

export type AdminConfig = {
  auth?: {
    apiKeys?: Array<string>
  }
  providers?: Record<string, ProviderConfig>
  extraPrompts?: Record<string, string>
  smallModel?: string
  freeModelLoadBalancing?: boolean
  /** @deprecated */
  apiKey?: string
  responsesApiContextManagementModels?: Array<string>
  modelReasoningEfforts?: Record<string, ReasoningEffort>
  modelAliases?: Record<string, ModelAliasSpec | string>
  allowOriginalModelNamesForAliases?: boolean
  useFunctionApplyPatch?: boolean
  forceAgent?: boolean
  compactUseSmallModel?: boolean
  messageStartInputTokensFallback?: boolean
  modelRefreshIntervalHours?: number
  useMessagesApi?: boolean
}

export type AdminConfigResponse = AdminConfig & {
  _configPath?: string
}

export type AdminModelsResponse = {
  items: string[]
}

export type AdminModelDetailsItem = {
  id: string
  name: string
  preview: boolean
  billing?: {
    is_premium?: boolean
    multiplier?: number
  }
  supported_endpoints?: Array<string>
  capabilities: {
    limits: {
      max_context_window_tokens?: number
      max_prompt_tokens?: number
      max_output_tokens?: number
    }
    supports: {
      tool_calls?: boolean
      parallel_tool_calls?: boolean
      structured_outputs?: boolean
      streaming?: boolean
      vision?: boolean
    }
  }
  aliases: Array<string>
}

export type AdminModelsDetailsResponse = {
  items: Array<AdminModelDetailsItem>
}

export class AdminApiError extends Error {
  readonly status: number
  readonly responseText: string

  constructor(status: number, responseText: string) {
    super(`HTTP ${status}: ${responseText}`)
    this.name = "AdminApiError"
    this.status = status
    this.responseText = responseText
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function fetchAdminJson<T>(
  path: string,
  init?: RequestInit,
  overrideToken?: string,
): Promise<T> {
  const token = overrideToken?.trim() ?? readAdminToken()
  const headers = new Headers(init?.headers ?? undefined)

  if (token) {
    headers.set("x-admin-token", token)
  }

  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  const res = await fetch(path, { ...init, headers })

  if (!res.ok) {
    const txt = await res.text().catch(() => "")
    let message = txt

    try {
      const parsed = JSON.parse(txt) as unknown
      if (isPlainObject(parsed) && "error" in parsed) {
        const err = (parsed as { error?: unknown }).error
        if (isPlainObject(err) && typeof (err as { message?: unknown }).message === "string") {
          message = (err as { message: string }).message
        }
      }
    } catch {
      // ignore JSON parsing errors and keep raw text
    }

    if (res.status === 401 || res.status === 403) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(ADMIN_TOKEN_REQUIRED_EVENT))
      }
    }

    throw new AdminApiError(res.status, message)
  }

  return (await res.json()) as T
}

export async function getAdminMeta(overrideToken?: string): Promise<AdminMeta> {
  return fetchAdminJson<AdminMeta>("/api/admin/meta", undefined, overrideToken)
}

export async function getAdminAccounts(params: {
  sinceMs: number
  includeStats?: boolean
}): Promise<AdminAccountsResponse> {
  const q = new URLSearchParams()
  q.set("since_ms", String(params.sinceMs))
  q.set("include_stats", params.includeStats === false ? "0" : "1")
  return fetchAdminJson<AdminAccountsResponse>(`/api/admin/accounts?${q.toString()}`)
}

export async function queryAdminRequests(params: {
  account_id?: string
  upstream_model?: string
  client_model?: string
  upstream_endpoint?: string
  path?: string
  status?: string
  has_error?: string
  from_ms?: string
  to_ms?: string
  limit?: number
  cursor_id?: number | null
}): Promise<AdminRequestsResponse> {
  const q = new URLSearchParams()
  if (params.account_id) q.set("account_id", params.account_id)
  if (params.upstream_model) q.set("upstream_model", params.upstream_model)
  if (params.client_model) q.set("client_model", params.client_model)
  if (params.upstream_endpoint) q.set("upstream_endpoint", params.upstream_endpoint)
  if (params.path) q.set("path", params.path)
  if (params.status) q.set("status", params.status)
  if (params.has_error) q.set("has_error", params.has_error)
  if (params.from_ms) q.set("from_ms", params.from_ms)
  if (params.to_ms) q.set("to_ms", params.to_ms)

  q.set("limit", String(params.limit ?? 50))
  if (params.cursor_id != null) q.set("cursor_id", String(params.cursor_id))

  return fetchAdminJson<AdminRequestsResponse>(`/api/admin/requests?${q.toString()}`)
}

export async function getAdminRequestDetail(
  requestId: string
): Promise<AdminRequestDetailResponse> {
  return fetchAdminJson<AdminRequestDetailResponse>(
    `/api/admin/requests/${encodeURIComponent(requestId)}`
  )
}

export async function getAdminConfig(): Promise<AdminConfigResponse> {
  return fetchAdminJson<AdminConfigResponse>("/api/admin/config")
}

export async function updateAdminConfig(
  patch: Partial<AdminConfig>
): Promise<AdminConfigResponse> {
  return fetchAdminJson<AdminConfigResponse>("/api/admin/config", {
    method: "POST",
    body: JSON.stringify(patch),
  })
}

export async function getAdminModels(): Promise<AdminModelsResponse> {
  return fetchAdminJson<AdminModelsResponse>("/api/admin/models")
}

export async function getAdminModelDetails(): Promise<AdminModelsDetailsResponse> {
  return fetchAdminJson<AdminModelsDetailsResponse>("/api/admin/models/details")
}
