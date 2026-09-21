import type { Context } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"
import { filterAllowedModels, isAllowedModel } from "~/lib/model-admission"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { readModelsCatalogResponse } from "~/routes/models/catalog-response"
import type {
  CodexModel,
  CodexModelsResponse,
  CodexReasoningEffort,
  SyntheticCodexModelCandidate,
} from "~/routes/models/codex-models-types"
import fallbackCodexCatalogJson from "~/routes/models/models.json"
import { forwardCodexModels } from "~/services/codex/get-models"
import { createProviderProxyResponse } from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("codex-models-handler")
const CODEX_USER_AGENT_PATTERN = /^codex/iu

const DEFAULT_REASONING_EFFORTS: Array<CodexReasoningEffort> = [
  "high",
  "xhigh",
  "max",
  "ultra",
]

const addUltraReasoningEffort = (
  efforts: Array<CodexReasoningEffort>,
): Array<CodexReasoningEffort> => {
  if (efforts.includes("ultra")) return efforts
  return [...efforts, "ultra"]
}

// Codex clients sort models by the `priority` field. The group bases keep the
// merged list ordered as: upstream catalog, codex provider aliases, copilot
// models, opencode-go models, then models from other providers.
const CODEX_ALIAS_PRIORITY_BASE = 1_000
const COPILOT_PRIORITY_BASE = 2_000
const OPENCODE_GO_PRIORITY_BASE = 3_000
const PROVIDER_PRIORITY_BASE = 4_000

// Bundled copy of the upstream Codex models catalog, downloaded from
// https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json
// Used when the upstream catalog is unavailable.
const FALLBACK_CODEX_MODELS = (
  fallbackCodexCatalogJson as unknown as CodexModelsResponse
).models
const FALLBACK_BASE_INSTRUCTIONS =
  FALLBACK_CODEX_MODELS.find((model) => model.base_instructions?.trim())
    ?.base_instructions ?? ""

interface MergedCodexModelsOptions {
  includeCodexProviderAliases?: boolean
  codexProviderName?: string
}

export function isCodexUserAgent(userAgent: string | undefined): boolean {
  return CODEX_USER_AGENT_PATTERN.test(userAgent?.trim() ?? "")
}

export function isDeepSeekModelId(modelId: string): boolean {
  return modelId.toLowerCase().includes("deepseek")
}

export function shouldInjectMessagesToolCallTips(
  userAgent: string | undefined,
  targetModel: string,
): boolean {
  return isCodexUserAgent(userAgent) && !isDeepSeekModelId(targetModel)
}

/**
 * Proxies a models request to the fixed Codex upstream models endpoint.
 * Returns a 404 JSON response when the codex provider is unavailable.
 * Pass `resolvedProviderConfig` when the caller already resolved the codex
 * provider to avoid a second resolve.
 */
export async function handleCodexModelsProxy(
  c: Context,
  resolvedProviderConfig?: ResolvedProviderConfig,
): Promise<Response> {
  const codexProviderConfig =
    resolvedProviderConfig ?? (await resolveProviderConfig("codex"))
  if (!codexProviderConfig) {
    return c.json(
      {
        error: {
          message: "Provider 'codex' not found or disabled",
          type: "invalid_request_error",
        },
      },
      404,
    )
  }

  const upstreamResponse = await forwardCodexModels(
    c.req.url,
    c.req.raw.headers,
  )
  if (!upstreamResponse.ok) {
    return createProviderProxyResponse(upstreamResponse)
  }

  let body: unknown
  try {
    body = await readModelsCatalogResponse(upstreamResponse)
  } catch {
    return invalidCodexCatalogResponse(c)
  }
  if (!isCodexModelsResponse(body)) {
    return invalidCodexCatalogResponse(c)
  }

  return createFilteredCodexCatalogResponse(upstreamResponse, body)
}

export async function handleMergedCodexModels(
  c: Context,
  candidatesRequest:
    | Array<SyntheticCodexModelCandidate>
    | Promise<Array<SyntheticCodexModelCandidate>>,
  options: MergedCodexModelsOptions = {},
): Promise<Response> {
  const [upstreamCatalog, candidates] = await Promise.all([
    tryGetCodexCatalog(c),
    Promise.resolve(candidatesRequest).catch((error: unknown) => {
      logger.warn("models.codex.candidates_error", { error })
      return []
    }),
  ])
  const upstreamModels = filterAllowedModels(
    upstreamCatalog?.models ?? FALLBACK_CODEX_MODELS,
    (model) => model.slug,
  ).map(sanitizeCodexModelReferences)
  const template = selectTemplate(upstreamModels)
  const catalogModelsBySlug = new Map(
    upstreamModels.map((model) => [model.slug, model]),
  )
  const seenSlugs = new Set(upstreamModels.map((model) => model.slug))
  const codexProviderAliases =
    options.includeCodexProviderAliases ?
      upstreamModels.flatMap((model, index) => {
        const slug = `codex/${model.slug}`
        if (seenSlugs.has(slug)) return []
        seenSlugs.add(slug)
        return [
          {
            ...createCatalogAlias(model, slug, options.codexProviderName),
            priority: CODEX_ALIAS_PRIORITY_BASE + index,
          },
        ]
      })
    : []
  const syntheticModels = candidates
    .filter(
      (candidate) =>
        isAllowedModel(candidate.catalogSlug ?? candidate.slug)
        && !seenSlugs.has(candidate.slug),
    )
    .flatMap((candidate, index) => {
      const priorityBase = getCandidatePriorityBase(candidate)
      const catalogModel =
        candidate.catalogSlug ?
          catalogModelsBySlug.get(candidate.catalogSlug)
        : undefined
      if (catalogModel) {
        return [
          {
            ...createCatalogAlias(
              catalogModel,
              candidate.slug,
              candidate.providerName,
            ),
            priority: priorityBase + index,
          },
        ]
      }
      if (candidate.catalogMatchRequired) return []

      return [
        createSyntheticCodexModel(candidate, template, priorityBase + index),
      ]
    })

  const models = [
    ...upstreamModels,
    ...codexProviderAliases,
    ...syntheticModels,
  ].sort((a, b) => getModelPriority(a) - getModelPriority(b))

  const response: CodexModelsResponse = {
    ...(upstreamCatalog ?? {}),
    models,
  }
  return c.json(response)
}

function invalidCodexCatalogResponse(c: Context): Response {
  return c.json(
    {
      error: {
        message: "Codex returned an invalid models catalog",
        type: "upstream_error",
      },
    },
    502,
  )
}

function createFilteredCodexCatalogResponse(
  upstreamResponse: Response,
  catalog: CodexModelsResponse,
): Response {
  const body: CodexModelsResponse = {
    ...catalog,
    models: filterAllowedModels(catalog.models, (model) => model.slug).map(
      sanitizeCodexModelReferences,
    ),
  }
  const rewrittenResponse = new Response(JSON.stringify(body), {
    headers: upstreamResponse.headers,
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
  })
  return createProviderProxyResponse(rewrittenResponse)
}

function sanitizeCodexModelReferences(model: CodexModel): CodexModel {
  const sanitized = { ...model }
  if (
    model.auto_review_model_override
    && !isAllowedModel(model.auto_review_model_override)
  ) {
    sanitized.auto_review_model_override = null
  }
  if (model.upgrade && !isAllowedModel(model.upgrade.model)) {
    sanitized.upgrade = null
  }
  return sanitized
}

function createCatalogAlias(
  model: CodexModel,
  slug: string,
  providerName: string | undefined,
): CodexModel {
  const alias = { ...model, slug }
  const prefix = providerName?.trim()
  if (
    !prefix
    || typeof alias.display_name !== "string"
    || alias.display_name.startsWith(`${prefix} `)
  ) {
    return alias
  }

  return {
    ...alias,
    display_name: `${prefix} ${alias.display_name}`,
  }
}

export function createSyntheticCodexModel(
  candidate: SyntheticCodexModelCandidate,
  template: CodexModel,
  priority: number,
): CodexModel {
  const reasoningEfforts =
    candidate.reasoningEfforts.length > 0 ?
      addUltraReasoningEffort(candidate.reasoningEfforts)
    : DEFAULT_REASONING_EFFORTS
  const defaultReasoningEffort =
    reasoningEfforts.includes(candidate.defaultReasoningEffort) ?
      candidate.defaultReasoningEffort
    : reasoningEfforts[0]
  const supportsReasoning = reasoningEfforts.some((effort) => effort !== "none")
  const inputModalities = [...new Set(candidate.inputModalities)]
  const isDeepSeekModel = isDeepSeekModelId(candidate.slug)

  return {
    ...template,
    slug: candidate.slug,
    display_name: candidate.displayName,
    description: candidate.description,
    priority,
    visibility: "list",
    supported_in_api: true,
    minimal_client_version: "0.0.0",
    prefer_websockets: false,
    support_verbosity: false,
    default_verbosity: "medium",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    supports_search_tool: false,
    use_responses_lite: isDeepSeekModel ? false : true,
    tool_mode: isDeepSeekModel ? null : "code_mode_only",
    multi_agent_version: "v2",
    multi_agent_reasoning_effort: null,
    shell_type: isDeepSeekModel ? "shell_command" : template.shell_type,
    experimental_supported_tools: [],
    input_modalities: inputModalities,
    supports_image_detail_original: false,
    supports_parallel_tool_calls: true,
    context_window: candidate.contextWindow,
    max_context_window: candidate.contextWindow,
    max_output_tokens: candidate.maxOutputTokens,
    auto_compact_token_limit: null,
    comp_hash: null,
    effective_context_window_percent: 95,
    default_reasoning_level: defaultReasoningEffort,
    supported_reasoning_levels: reasoningEfforts.map((effort) => ({
      effort,
      description: `${effort} reasoning effort`,
    })),
    supports_reasoning_summary_parameter: supportsReasoning,
    supports_reasoning_summaries: supportsReasoning,
    default_reasoning_summary: supportsReasoning ? "auto" : "none",
    reasoning_summary_format: "experimental",
    availability_nux: null,
    upgrade: null,
    available_in_plans: template.available_in_plans,
    model_messages: template.model_messages,
    auto_review_model_override: null,
    default_service_tier: null,
    service_tiers: [],
    additional_speed_tiers: [],
    include_skills_usage_instructions: false,
    truncation_policy: { mode: "tokens", limit: 10_000 },
    base_instructions:
      template.base_instructions?.trim() ?
        template.base_instructions
      : FALLBACK_BASE_INSTRUCTIONS,
  }
}

async function tryGetCodexCatalog(
  c: Context,
): Promise<CodexModelsResponse | null> {
  try {
    const providerConfig = await resolveProviderConfig("codex")
    if (!providerConfig) return null

    const response = await forwardCodexModels(c.req.url, c.req.raw.headers)
    if (!response.ok) {
      logger.warn("models.codex.catalog_fallback", {
        statusCode: response.status,
      })
      return null
    }

    const body = await readModelsCatalogResponse(response)
    if (!isCodexModelsResponse(body)) {
      logger.warn("models.codex.catalog_invalid")
      return null
    }
    return body
  } catch (error) {
    logger.warn("models.codex.catalog_error", { error })
    return null
  }
}

function selectTemplate(models: Array<CodexModel>): CodexModel {
  const candidates = models.length > 0 ? models : FALLBACK_CODEX_MODELS
  return (
    candidates.find(
      (model) =>
        model.visibility === "list" && model.supported_in_api !== false,
    ) ?? candidates[0]
  )
}

function getModelPriority(model: CodexModel): number {
  return typeof model.priority === "number" && Number.isFinite(model.priority) ?
      model.priority
    : 0
}

function getCandidatePriorityBase(
  candidate: SyntheticCodexModelCandidate,
): number {
  if (!candidate.providerName) return COPILOT_PRIORITY_BASE
  if (candidate.providerName === "opencode-go") return OPENCODE_GO_PRIORITY_BASE
  return PROVIDER_PRIORITY_BASE
}

function isCodexModelsResponse(value: unknown): value is CodexModelsResponse {
  if (!isRecord(value) || !Array.isArray(value.models)) return false
  return value.models.every(
    (model: unknown) => isRecord(model) && typeof model.slug === "string",
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
