export type RequestOutcome = "completed" | "cancelled" | "error" | null

export interface RequestTiming {
  id: string
  firstTokenMs: number | null
  durationMs: number | null
  outcome: RequestOutcome
  protocolFailed?: boolean
  hasUsage: boolean
  recordFirstToken: () => void
}

export type TokenUsageSource = "copilot" | "provider"

export type TokenUsageEndpoint =
  | "alpha_search"
  | "chat_completions"
  | "embeddings"
  | "generate_content"
  | "images_generations"
  | "images_edits"
  | "messages"
  | "provider_messages"
  | "responses"
  | "videos_generations"

export type TokenUsagePeriod =
  | "today"
  | "this_week"
  | "last_7_days"
  | "this_month"
  | "last_30_days"
  | "lifetime"

export interface ImageTokenDetails {
  image_tokens?: number
  text_tokens?: number
}

export interface UsageTokens {
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  cost?: number | null
  input_tokens?: number | null
  input_tokens_details?: ImageTokenDetails
  output_tokens?: number | null
  output_tokens_details?: ImageTokenDetails
  total_nano_aiu?: number | null
  total_tokens?: number | null
}

export interface TokenUsageCost {
  amount: number
  currency: string
  total_cost_nanos: number
}

export interface TokenUsageEventCost extends TokenUsageCost {
  source: string
}

export interface TokenUsageTiming {
  request_id: string | null
  first_token_ms: number | null
  duration_ms: number | null
  request_outcome: RequestOutcome
}

export interface PersistedTokenUsageEvent extends TokenUsageTiming {
  api_key_cost_nanos?: number | null
  api_key_id?: string | null
  api_key_name?: string | null
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cost_currency: string | null
  cost_source: string | null
  created_at_ms: number
  created_at_utc: string
  endpoint: TokenUsageEndpoint
  input_tokens: number
  model: string
  output_tokens: number
  provider_name: string | null
  session_id: string
  source: TokenUsageSource
  total_cost_nanos: number | null
  total_nano_aiu: number | null
  total_tokens: number
  trace_id: string
  user_agent: string
  user_id: string
  upstream_request_id?: string | null
}

export interface TokenUsageTotals {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  costs: Array<TokenUsageCost>
  input_tokens: number
  output_tokens: number
  request_count: number
  total_nano_aiu: number | null
  total_tokens: number
}

export interface TokenUsageModelSummary extends TokenUsageTotals {
  average_first_token_ms: number | null
  output_tokens_per_second: number | null
  model: string
}

export interface TokenUsageSessionSummary extends TokenUsageTotals {
  session_id: string
}

export interface TokenUsageEventRecord extends TokenUsageTiming {
  api_key_id?: string | null
  api_key_name?: string | null
  output_tokens_per_second: number | null
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cost: TokenUsageEventCost | null
  created_at_ms: number
  created_at_utc: string
  endpoint: TokenUsageEndpoint
  id: number
  input_tokens: number
  model: string
  output_tokens: number
  provider_name: string | null
  session_id: string
  source: TokenUsageSource
  total_nano_aiu: number | null
  total_tokens: number
  trace_id: string
  user_agent: string
  user_id: string
}

export interface TokenUsageSummary {
  byModel: Array<TokenUsageModelSummary>
  period: TokenUsagePeriod
  range: {
    end_ms: number
    end_utc: string
    start_ms: number
    start_utc: string
  }
  totals: TokenUsageTotals
}

export interface TokenUsageDailyBucket {
  byModel: Array<TokenUsageModelSummary>
  date: string
  end_ms: number
  start_ms: number
  totals: TokenUsageTotals
}

export interface TokenUsageDailySummary {
  byModel: Array<TokenUsageModelSummary>
  days: Array<TokenUsageDailyBucket>
  period: TokenUsagePeriod
  range: {
    end_ms: number
    end_utc: string
    start_ms: number
    start_utc: string
  }
  totals: TokenUsageTotals
}

export interface TokenUsagePage<T> {
  items: Array<T>
  page: number
  page_size: number
  period: TokenUsagePeriod
  range: {
    end_ms: number
    end_utc: string
    start_ms: number
    start_utc: string
  }
  total: number
  total_pages: number
}

export type TokenUsageEventsPage = TokenUsagePage<TokenUsageEventRecord>
export type TokenUsageSessionsPage = TokenUsagePage<TokenUsageSessionSummary>

export interface TokenUsagePageInput {
  page: number
  pageSize: number
  period: TokenUsagePeriod
  apiKeyId?: string | null
}

export interface VideoUsageJob {
  provider_name: string
  request_id: string
  api_key_id: string
  api_key_name: string | null
  model: string
  trace_id: string
  session_id: string
  settled: number
  next_poll_at_ms: number | null
}
