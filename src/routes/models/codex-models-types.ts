export interface CodexModelsResponse {
  models: Array<CodexModel>
  [key: string]: unknown
}

export interface CodexModel {
  slug: string
  prefer_websockets: boolean
  support_verbosity: boolean
  default_verbosity: CodexVerbosity
  apply_patch_tool_type: CodexApplyPatchToolType
  web_search_tool_type: CodexWebSearchToolType
  input_modalities: Array<CodexInputModality>
  supports_image_detail_original: boolean
  truncation_policy: CodexTruncationPolicy
  supports_parallel_tool_calls: boolean
  tool_mode: CodexToolMode | null
  multi_agent_version: CodexMultiAgentVersion | null
  use_responses_lite: boolean
  include_skills_usage_instructions: boolean
  auto_review_model_override: string | null
  context_window: number
  max_context_window: number
  max_output_tokens?: number
  effective_context_window_percent?: number
  auto_compact_token_limit: number | null
  comp_hash: string | null
  reasoning_summary_format: CodexReasoningSummaryFormat
  default_reasoning_summary: CodexReasoningSummary
  display_name: string
  description: string
  default_reasoning_level: CodexReasoningEffort
  supported_reasoning_levels: Array<CodexReasoningLevel>
  shell_type: CodexShellType
  visibility: CodexModelVisibility
  minimal_client_version: string
  supported_in_api: boolean
  availability_nux: CodexAvailabilityNux | null
  upgrade: CodexModelUpgrade | null
  priority: number
  model_messages: CodexModelMessages
  experimental_supported_tools: Array<string>
  available_in_plans: Array<CodexModelPlan>
  supports_search_tool: boolean
  default_service_tier: string | null
  service_tiers: Array<CodexServiceTier>
  additional_speed_tiers: Array<string>
  supports_reasoning_summary_parameter: boolean
  supports_reasoning_summaries: boolean
  base_instructions: string
  [key: string]: unknown
}

export type CodexVerbosity = "low" | "medium"

export type CodexApplyPatchToolType = "freeform"

export type CodexWebSearchToolType = "text_and_image"

export type CodexInputModality = "text" | "image"

export interface CodexTruncationPolicy {
  mode: "tokens"
  limit: number
}

export type CodexToolMode = "code_mode" | "code_mode_only"

export type CodexMultiAgentVersion = "v1" | "v2"

export type CodexReasoningSummaryFormat = "experimental"

export type CodexReasoningSummary = "auto" | "none"

export type CodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"

export interface CodexReasoningLevel {
  effort: CodexReasoningEffort
  description: string
}

export type CodexShellType = "shell_command"

export type CodexModelVisibility = "list" | "hide"

export interface CodexAvailabilityNux {
  message: string
}

export interface CodexModelUpgrade {
  model: string
  migration_markdown: string
}

export type CodexModelPlan =
  | "business"
  | "edu"
  | "edu_plus"
  | "edu_pro"
  | "education"
  | "enterprise"
  | "enterprise_cbp_automation"
  | "enterprise_cbp_usage_based"
  | "finserv"
  | "free"
  | "free_workspace"
  | "go"
  | "hc"
  | "k12"
  | "plus"
  | "pro"
  | "prolite"
  | "quorum"
  | "sci"
  | "self_serve_business_usage_based"
  | "team"

export interface CodexServiceTier {
  id: string
  name: string
  description: string
}

export interface CodexModelMessages {
  instructions_template: string
  instructions_variables: CodexInstructionsVariables | null
  approvals: unknown
  auto_review: unknown
  permissions: unknown
}

export interface CodexInstructionsVariables {
  personality_default?: string
  personality_friendly?: string
  personality_pragmatic?: string
}

export interface SyntheticCodexModelCandidate {
  slug: string
  catalogSlug?: string
  catalogMatchRequired?: boolean
  providerName?: string
  displayName: string
  description: string
  contextWindow: number
  maxPromptTokens?: number
  maxOutputTokens: number
  inputModalities: Array<CodexInputModality>
  reasoningEfforts: Array<CodexReasoningEffort>
  defaultReasoningEffort: CodexReasoningEffort
}
