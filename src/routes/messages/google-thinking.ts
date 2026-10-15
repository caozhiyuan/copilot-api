import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import type {
  GoogleThinkingConfig,
  GoogleThinkingLevel,
} from "~/lib/types/google"

interface ThinkingCapabilities {
  levels?: Array<GoogleThinkingLevel>
  budget?: { min: number; max: number; canDisable: boolean }
}

const ALL_LEVELS: Array<GoogleThinkingLevel> = [
  "MINIMAL",
  "LOW",
  "MEDIUM",
  "HIGH",
]
const STANDARD_LEVELS: Array<GoogleThinkingLevel> = ["LOW", "MEDIUM", "HIGH"]

// https://ai.google.dev/gemini-api/docs/generate-content/thinking
// Keep unknown aliases on upstream defaults rather than guessing capabilities.
function getThinkingCapabilities(
  modelId: string,
): ThinkingCapabilities | undefined {
  const model = modelId.replace(/^models\//u, "").toLowerCase()
  if (
    /^gemini-2\.5-(?:pro|flash)(?:-|$)/u.test(model)
    && !model.includes("-image")
  ) {
    const pro = model.startsWith("gemini-2.5-pro")
    return {
      budget: {
        min:
          pro ? 128
          : model.includes("flash-lite") ? 512
          : 0,
        max: pro ? 32768 : 24576,
        canDisable: !pro,
      },
    }
  }
  if (/^gemini-3-pro-image(?:-|$)/u.test(model)) return { levels: ["HIGH"] }
  if (/^gemini-3\.1-(?:flash|flash-lite)-image(?:-|$)/u.test(model))
    return { levels: ["MINIMAL", "HIGH"] }
  if (/^gemini-3-pro(?:-|$)/u.test(model)) return { levels: ["LOW", "HIGH"] }
  if (
    /^gemini-3\.1-pro(?:-|$)/u.test(model)
    || /^gemini-3\.[78]-flash(?:-|$)/u.test(model)
    || /^gemini-4-argon(?:-|$)/u.test(model)
  )
    return { levels: STANDARD_LEVELS }
  if (/^gemini-3(?:\.[156])?-flash(?:-|$)/u.test(model))
    return { levels: ALL_LEVELS }
  return undefined
}

function supportedLevel(
  requested: GoogleThinkingLevel,
  levels: Array<GoogleThinkingLevel>,
): GoogleThinkingLevel {
  const rank = ALL_LEVELS.indexOf(requested)
  return (
    levels.findLast((level) => ALL_LEVELS.indexOf(level) <= rank) ?? levels[0]
  )
}

export function translateGoogleThinking(
  payload: AnthropicMessagesPayload,
): GoogleThinkingConfig | undefined {
  const thinking = payload.thinking
  const effort = payload.output_config?.effort
  if (!thinking && !effort) return undefined
  const capabilities = getThinkingCapabilities(payload.model)
  if (!capabilities) return undefined
  const config: GoogleThinkingConfig = {
    includeThoughts: thinking?.type !== "disabled",
  }
  const { budget, levels } = capabilities

  // Explicit disabled takes precedence over budgets and effort. Models that
  // cannot turn thinking off use their lowest supported setting instead.
  if (thinking?.type === "disabled") {
    if (budget) config.thinkingBudget = budget.canDisable ? 0 : budget.min
    if (levels) config.thinkingLevel = levels[0]
    return config
  }

  const requestedBudget = thinking?.budget_tokens
  if (requestedBudget !== undefined) {
    if (budget) {
      config.thinkingBudget =
        requestedBudget === -1 ? -1 : (
          Math.max(budget.min, Math.min(requestedBudget, budget.max))
        )
    } else if (levels && requestedBudget !== -1) {
      // Gateway policy for a token budget on level-only models; these are
      // relative effort tiers, not a Google guarantee of token consumption.
      const level =
        requestedBudget <= 2048 ? "LOW"
        : requestedBudget <= 8192 ? "MEDIUM"
        : "HIGH"
      config.thinkingLevel = supportedLevel(level, levels)
    }
    return config
  }

  if (effort) {
    const level =
      effort === "low" ? "LOW"
      : effort === "medium" ? "MEDIUM"
      : "HIGH"
    if (levels) config.thinkingLevel = supportedLevel(level, levels)
    // Gemini 2.5 does not accept thinkingLevel. These are gateway defaults;
    // an explicit Anthropic budget above always takes precedence.
    if (budget)
      config.thinkingBudget =
        effort === "low" ? 2048
        : effort === "medium" ? 8192
        : effort === "high" ? 16384
        : budget.max
  }
  return config
}
