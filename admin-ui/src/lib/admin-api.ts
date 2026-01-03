import { readAdminToken } from "@/lib/admin-token"

export type AdminMeta = {
  userVersion?: number
  dbPath?: string
}

export type AdminAccountItem = {
  account_id: string
  account_type?: string
  runtime?: {
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

async function fetchAdminJson<T>(path: string): Promise<T> {
  const token = readAdminToken()
  const headers: Record<string, string> = {}
  if (token) headers["x-admin-token"] = token

  const res = await fetch(path, { headers })
  if (!res.ok) {
    const txt = await res.text().catch(() => "")
    let message = txt

    try {
      const parsed = JSON.parse(txt) as unknown
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof (parsed as { error?: unknown }).error === "object" &&
        (parsed as { error?: { message?: unknown } }).error !== null &&
        typeof (parsed as { error?: { message?: unknown } }).error?.message ===
          "string"
      ) {
        message = (parsed as { error: { message: string } }).error.message
      }
    } catch {
      // ignore JSON parsing
    }

    throw new AdminApiError(res.status, message)
  }

  return (await res.json()) as T
}

export async function getAdminMeta(): Promise<AdminMeta> {
  return fetchAdminJson<AdminMeta>("/api/admin/meta")
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
