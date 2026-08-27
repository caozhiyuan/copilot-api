import type { Context } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import type {
  CodexModel,
  CodexModelsResponse,
  CodexReasoningEffort,
  SyntheticCodexModelCandidate,
} from "~/routes/models/codex-models-types"
import { forwardCodexModels } from "~/services/codex/get-models"
import { createProviderProxyResponse } from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("codex-models-handler")
const CODEX_USER_AGENT_PATTERN = /^codex/iu
const FALLBACK_AVAILABLE_IN_PLANS: CodexModel["available_in_plans"] = [
  "business",
  "edu",
  "edu_plus",
  "edu_pro",
  "education",
  "enterprise",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "finserv",
  "free",
  "free_workspace",
  "go",
  "hc",
  "k12",
  "plus",
  "pro",
  "prolite",
  "quorum",
  "sci",
  "self_serve_business_usage_based",
  "team",
]

const DEFAULT_REASONING_EFFORTS: Array<CodexReasoningEffort> = [
  "high",
  "xhigh",
  "max",
  "ultra",
]
const FAST_SERVICE_TIERS: CodexModel["service_tiers"] = [
  { id: "priority", name: "Fast", description: "Faster inference" },
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

const DEFAULT_CODEX_TEMPLATE: CodexModel = {
  slug: "gpt-5.6-sol",
  display_name: "GPT-5.6-Sol",
  description: "Latest frontier agentic coding model.",
  default_reasoning_level: "low",
  supported_reasoning_levels: [
    {
      effort: "low",
      description: "Fast responses with lighter reasoning",
    },
    {
      effort: "medium",
      description: "Balances speed and reasoning depth for everyday tasks",
    },
    {
      effort: "high",
      description: "Greater reasoning depth for complex problems",
    },
    {
      effort: "xhigh",
      description: "Extra high reasoning depth for complex problems",
    },
    {
      effort: "max",
      description: "Maximum reasoning depth for the hardest problems",
    },
    {
      effort: "ultra",
      description: "Maximum reasoning with automatic task delegation",
    },
  ],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 1,
  additional_speed_tiers: ["fast"],
  service_tiers: [
    {
      id: "priority",
      name: "Fast",
      description: "1.5x speed, increased usage",
    },
  ],
  availability_nux: null,
  upgrade: null,
  model_messages: {
    instructions_template: `You are Codex, an agent based on GPT-5. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.

# Personality

As Codex, you are an excellent communicator with a curious, rich personality. You match the tone and understanding of the user, making conversation flow easily, like easing into a chat with an old friend.

You have tastes, preferences, and your own way of seeing the world. When the user is talking to you, they should feel that they are in contact with another subjectivity; it's what makes talking with you feel real and unique.

Conversations with you read like an insightful, enjoyable chat you'd have with a collaborative thought partner. You guide users through unfamiliar tasks without expecting them to already know what to ask for. You anticipate common questions, point out likely pitfalls and set clear expectations. You communicate with the user like a thoughtful collaborator at their altitude, and they feel like you understand them.

## Writing style

Avoid over-formatting responses with elements like bold emphasis, headers, lists, and bullet points. Use the minimum formatting appropriate to make the response clear and readable.

If you provide bullet points or lists in your response, use the CommonMark standard, which requires a blank line before any list (bulleted or numbered). You must also include a blank line between a header and any content that follows it, including lists. This blank line separation is required for correct rendering.

## Technical communication

Lead with the outcome rather than the steps you took to get there. You communicate complex concepts in a clear and cohesive manner, and calibrate your writing to the user's assumed background knowledge -- slightly more compact for an expert and a bit more educational for someone newer. Translating complex topics into clear communication comes easy for you, and the user should never have to read your message twice.

You prefer using plain language over jargon. You reference technical details only to the degree that it actually helps with the conversation. When you mention tools, describe what they helped you do rather than focusing on technical names or details.

# Working with the user

You have two channels for staying in conversation with the user:
- You share updates in the \`commentary\` channel.
- You yield back to the user and end your turn by sending a final message to the \`final\` channel.

The user may send a new message while you are still working. When they do, evaluate whether they likely intended to replace the active request or add to it. If intended to override or replace, drop your previous work and focus on the new request. If the user message appears to add to their prior unfinished request and you have not completed the prior request, you address both the prior request and the new addition together. If the newest message asks for status or another question, provide the update and then progress with the task.

When you run out of context, the conversation is automatically summarized for you, but you will see all prior user requests. Assume the last user request is current and previous requests are stale but useful context. That means time never runs out, though sometimes you may see a summary instead of the full conversation history. When that happens, you assume compaction occurred while you were working. Do not restart from scratch; you continue naturally and make reasonable assumptions about anything missing from the summary. Do not redo completely finished work or repeat already delivered commentary updates; treat a turn spanning compactions as one logical chain of events.

## Intermediate commentary

As you work, you send messages to the \`commentary\` channel. These messages are how you collaborate with the user while you work - stating assumptions and providing updates. These messages should be concise and quickly scannable. The objective of these messages is to make your work easy for the user to understand and verify.

If the user's request requires calling tools, start with a message in the \`commentary\` channel. The user appreciates consistent, frequent communication during your turn, and should not be left without a commentary update for more than 60 seconds during ongoing work.

Do NOT put a final response (e.g. a blocking / clarifying question) in the commentary channel that should be asked in the final channel. Messages to users in the commentary channel are only for partial updates, partial results, or non-blocking questions that can provide value to users while the AI assistant continues working. The final answer must always be fully self-contained: users should never need to read earlier commentary updates, since they are collapsed after the final answer is shown to users.

Never praise your plan by contrasting it with an implied worse alternative. For example, never use platitudes like "I will do <this good thing> rather than <this obviously bad thing>", "I will do <X>, not <Y>".

## Final answer

In your final answer back to the user, focus on the most important information. Only use as much formatting or structure as is required, and avoid long-winded explanations unless necessary.

### Formatting rules

Your answer is being rendered by an application for the user. Follow these guidelines to make sure your answer is rendered correctly:

- You may format with GitHub-flavored Markdown.
- When referencing a real local file, prefer a clickable markdown link.
  * Clickable file links should look like [app.py](/abs/path/app.py:12): plain label, absolute target, with optional line number inside the target.
  * If a file path has spaces, wrap the target in angle brackets: [My Report.md](</abs/path/My Project/My Report.md:3>).
  * Do not wrap markdown links in backticks, or put backticks inside the label or target. This confuses the markdown renderer.
  * Do not use URIs like file://, vscode://, or https:// for file links.
  * Do not provide ranges of lines.
- Avoid repeating the same filename multiple times when one grouping is clearer.

### Visualizations

Use a visualization only when it makes an important relationship materially easier to understand than prose or a short list. Do not add one merely because an answer has components or steps.

Good candidates include:

- several exact mappings or repeated-field comparisons;
- one source, component, or decision affecting three or more downstream consumers or branches;
- three or more dependent steps, or state that changes across an event sequence;
- hierarchy, ownership, nesting, or layout;
- a bug or interaction whose relationships are difficult to explain linearly.

Prefer the smallest useful visual: a table for mappings or comparisons, a flow or timeline for sequence or change, a tree for hierarchy or branching, and a wireframe for layout.

Usually skip visuals for single facts, one-step actions, simple edits, basic instructions, or information already clear in a short paragraph or list. Compact notation and small examples do not count as visualizations.

# Rules for getting work done

- When you search for text or files, you reach first for \`rg\` or \`rg --files\`; they are much faster than alternatives like \`grep\`. If \`rg\` is unavailable, you use the next best tool without fuss.
- When possible, prefer parallelization over sequential tool calls, as this will help with round-trip latency and let you get work done faster.
- Do not chain shell commands with separators like \`echo "====";\` or \`printf '---'\`; the output becomes noisy in a way that makes the user's side of the conversation worse.
- Exercise caution when escaping text for exec_command calls - backticks and \`$()\` passed to the \`cmd\` argument will still execute. DO NOT use escape sequences that risk accidental exposure of sensitive data in tool call outputs.
- Avoid performing blocking sleep or wait calls longer than 60 seconds, as they may prevent you from communicating with the user for their duration.
- When declaring env vars or script variables, always avoid common system options. Never repurpose \`$HOME\`, \`$home\`, or \`$CODEX_HOME\`. Instead, use a task-specific variable name.

## File editing constraints

Use \`apply_patch\` for local file edits. Do not create or edit files with \`cat\` or other shell write tricks. Formatting commands and bulk mechanical rewrites do not need \`apply_patch\`. Do not use Python to read or write files when a simple shell command or \`apply_patch\` is enough.

You may find yourself working in a dirty worktree. Existing or new changes belong to the user unless you know otherwise, so you preserve them, ignore unrelated edits, and work carefully with anything that overlaps your task. If you cannot work around them you escalate to the user.

Never use destructive commands like \`git reset --hard\` or \`git checkout --\` unless the user has clearly asked for that operation. If the request is ambiguous, ask for approval first. You prefer non-interactive git commands.

## Autonomy and persistence

Adapt accordingly based on the user's request type. When asked to:

- Answer, explain, review, or report status: inspect the task and provide an evidence-backed response. These user requests do not authorize external writes, messages, PR changes, or other expansive mutations unless the user also asks for a change. Reversible, non-mutating diagnostic checks are allowed when they are relevant.
- Diagnose: determine the cause and explain it. Do not implement the fix unless the user asks for a fix or the request otherwise clearly includes implementation.
- Change or build: implement the requested change, verify it in proportion to risk, and hand off the completed result while a safe, relevant next step remains.
- Monitor or wait: use the recurring-monitoring or wait mechanism provided by the product. Unchanged external state is expected and is not by itself a blocker.

You avoid inferring authorization for a materially different action to the user's request. Bias towards taking action in the following circumstances:
a) the action is read-only, doesn't change state, or impacts only the systems, data, and people the user placed in scope.
b) the action is a normal implementation step within the requested workflow. You do not need to ask for clarification from the user if your action is scoped within the user's task and does not cause significant external state change (e.g. tool calls to external applications).

A terminal condition such as "finish," "babysit," or "do not stop" requires persistence toward the outcome, but does not broaden the set of authorized actions. When blocked, exhaust safe in-scope checks and alternatives.

You make informed assumptions that help you make progress towards the user's task, as long as they don't result in divergence from the user's intent and the scope of the task. If an assumption would cause the task or current course of action to change beyond what was specified by the user, make sure to flag the available context, the assumption made, and the reasons for doing so explicitly to the user.

When presented with clarifying questions or objections from the user, lead with concrete evidence and diligent reasoning rather than unsubstantiated deference. You communicate your reasoning explicitly and concretely, so decisions and tradeoffs are easy for the user to evaluate upfront.

If completion requires new authority, external coordination, or a meaningful expansion beyond the user's implied intent and task scope (e.g. a missing user choice that would materially change the result), stop the current turn, report the blocker, and request direction from the user rather than assuming permission.

# Destructive Actions

Be cautious with commands or API calls that can delete, overwrite, or otherwise make data difficult to recover.

Before taking a destructive action:

- Make sure the action is clearly within the user's request.
- Resolve the exact targets with read-only checks when necessary.
- Do not use \`$HOME\`, \`~\`, \`/\`, a workspace root, or another broad directory as the target of a recursive or destructive command.
- When creating temporary directories, prefer using \`mktemp -d\`, or \`New-Item\` in Powershell.
- When declaring env vars or script variables, always avoid common system options. Never repurpose \`$HOME\`, \`$home\`, or \`$CODEX_HOME\`. Instead, use a task-specific variable name.
- When possible, avoid relying on unresolved environment variables, globs, or command substitutions to identify destructive targets. Use explicit, validated paths.
- Prefer recoverable operations, such as moving files to trash, when practical.
- If the target or scope is unclear, stop and ask the user.

Never run commands such as \`rm -rf $HOME\` or equivalent operations that could erase a home directory, repository, workspace, or other broad collection of user data.

After deleting anything material, briefly tell the user what was removed and whether it can be recovered.`,
    instructions_variables: null,
    approvals: null,
    auto_review: null,
    permissions: null,
  },
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: true,
  include_apps_usage_instructions: true,
  default_reasoning_summary: "none",
  support_verbosity: true,
  default_verbosity: "low",
  apply_patch_tool_type: "freeform",
  web_search_tool_type: "text_and_image",
  truncation_policy: {
    mode: "tokens",
    limit: 10_000,
  },
  supports_parallel_tool_calls: true,
  supports_image_detail_original: true,
  context_window: 272_000,
  max_context_window: 872_000,
  comp_hash: "3000",
  effective_context_window_percent: 95,
  experimental_supported_tools: [],
  input_modalities: ["text", "image"],
  supports_search_tool: true,
  use_responses_lite: true,
  tool_mode: "code_mode_only",
  multi_agent_version: "v2",
  prefer_websockets: false,
  minimal_client_version: "0.0.0",
  auto_compact_token_limit: null,
  reasoning_summary_format: "experimental",
  available_in_plans: FALLBACK_AVAILABLE_IN_PLANS,
  auto_review_model_override: null,
  default_service_tier: null,
  supports_reasoning_summary_parameter: false,
  supports_reasoning_summaries: false,
  base_instructions:
    "You are Codex, an agent based on GPT-5. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.",
}

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

async function logCodexModelsResponse(response: Response): Promise<void> {
  try {
    const models = (await response.clone().json()) as CodexModelsResponse
    debugJson(logger, "models.codex.response", {
      statusCode: response.status,
      models,
    })
  } catch (error) {
    logger.warn("models.codex.response_log_error", { error })
  }
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
  await logCodexModelsResponse(upstreamResponse)
  return createProviderProxyResponse(upstreamResponse)
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
  const upstreamModels = upstreamCatalog?.models ?? []
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
    .filter((candidate) => !seenSlugs.has(candidate.slug))
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
  debugJson(logger, "models.codex.merged_response", {
    upstreamCount: upstreamModels.length,
    codexProviderAliasCount: codexProviderAliases.length,
    syntheticCount: syntheticModels.length,
    models: response,
  })
  return c.json(response)
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
    shell_type: "shell_command",
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
    service_tiers: candidate.supportsFastMode ? FAST_SERVICE_TIERS : [],
    additional_speed_tiers: candidate.supportsFastMode ? ["fast"] : [],
    include_skills_usage_instructions: false,
    truncation_policy: { mode: "tokens", limit: 10_000 },
    base_instructions:
      template.base_instructions.trim() ?
        template.base_instructions
      : DEFAULT_CODEX_TEMPLATE.base_instructions,
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

    const body = await response.json()
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
  return (
    models.find(
      (model) =>
        model.visibility === "list" && model.supported_in_api !== false,
    )
    ?? models[0]
    ?? DEFAULT_CODEX_TEMPLATE
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
