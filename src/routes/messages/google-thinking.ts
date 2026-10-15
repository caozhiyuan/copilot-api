import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import type { GoogleThinkingConfig } from "~/lib/types/google"

// Gateway-owned thinking controls target Gemini 3.8 Flash and Gemini 4.0+
// text models. Other identifiers retain upstream defaults.
function supportsThinkingControls(modelId: string): boolean {
  const model = modelId.replace(/^models\//u, "").toLowerCase()
  if (/(?:^|-)(?:tts|live|image)(?:-|$)/u.test(model)) return false
  if (/^gemini-3\.8-flash(?:-|$)/u.test(model)) return true
  const major = /^gemini-(\d+)(?:\.\d+)?(?:-|$)/u.exec(model)?.[1]
  return major !== undefined && Number(major) >= 4
}

// https://ai.google.dev/gemini-api/docs/generate-content/thinking
export function translateGoogleThinking(
  payload: AnthropicMessagesPayload,
): GoogleThinkingConfig | undefined {
  const thinking = payload.thinking
  const effort = payload.output_config?.effort
  if ((!thinking && !effort) || !supportsThinkingControls(payload.model))
    return undefined
  const config: GoogleThinkingConfig = {
    includeThoughts: thinking?.type !== "disabled",
  }

  // These models use LOW/MEDIUM/HIGH and cannot turn thinking off. Explicit
  // disabled takes precedence over an Anthropic budget or effort setting.
  if (thinking?.type === "disabled") return { ...config, thinkingLevel: "LOW" }

  const requestedBudget = thinking?.budget_tokens
  if (requestedBudget !== undefined) {
    // Interpret an Anthropic budget as a relative tier, never as a native
    // Google thinkingBudget. -1 keeps Google's dynamic default.
    if (requestedBudget !== -1) {
      config.thinkingLevel =
        requestedBudget <= 2048 ? "LOW"
        : requestedBudget <= 8192 ? "MEDIUM"
        : "HIGH"
    }
    return config
  }

  if (effort)
    config.thinkingLevel =
      effort === "low" ? "LOW"
      : effort === "medium" ? "MEDIUM"
      : "HIGH"
  return config
}
