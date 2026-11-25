import { parseProviderModelAlias } from "~/lib/catalog/provider-model"
import {
  resolveEffectiveProviderType,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { GITHUB_COPILOT_PROVIDER } from "~/lib/providers/github-copilot-provider"
import type { GoogleGenerateContentRequest } from "~/lib/types/google"
import {
  getStringField,
  type ClientModel,
} from "~/routes/models/model-discovery"
import { getModelMetadata } from "~/routes/models/model-metadata"

const EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
} as const
type Effort = keyof typeof EFFORT_LABELS
const EFFORTS = Object.keys(EFFORT_LABELS) as Array<Effort>

// These native Gemini IDs support level-based thinking on GenerateContent.
const GOOGLE_THINKING_LEVELS = new Map<string, ReadonlyArray<Effort>>([
  ["gemini-3.8-flash", ["low", "medium", "high"]],
  ["gemini-4-argon", ["low", "medium", "high"]],
  ["gemini-4-carbon", ["low", "medium", "high"]],
  ["gemini-4-hydrogen", ["low", "medium", "high", "xhigh"]],
  ["gemini-4-neon", ["low", "medium", "high", "xhigh"]],
])

export interface AntigravityModelVariant {
  model: string
  effort: Effort
}

export function hasAntigravityEffortSuffix(model: string): boolean {
  return EFFORTS.some((effort) => model.endsWith(`-${effort}`))
}

export function createAntigravityModelCatalog(
  models: Array<ClientModel>,
  getProviderConfig: (name: string) => ResolvedProviderConfig | null,
) {
  const ids = new Set(models.map(({ id }) => id))
  const variants = new Map<string, AntigravityModelVariant>()
  const entries = models.flatMap((model) => {
    // Existing variant IDs are already visible to the client.
    if (
      EFFORTS.some(
        (effort) =>
          model.id.endsWith(`-${effort}`)
          && ids.has(model.id.slice(0, -effort.length - 1)),
      )
    ) {
      return [model]
    }

    const alias = parseProviderModelAlias(model.id)
    const provider = alias ? getProviderConfig(alias.provider) : null
    const modelId = provider && alias ? alias.model : model.id
    const { reasoningEfforts } = getModelMetadata(
      provider?.name ?? GITHUB_COPILOT_PROVIDER,
      modelId,
      model,
      provider,
    )
    const nativeGoogle =
      provider && resolveEffectiveProviderType(provider, modelId) === "google"
    const nativeLevels =
      nativeGoogle ? GOOGLE_THINKING_LEVELS.get(modelId) : undefined
    const supported =
      reasoningEfforts.length > 0 ? reasoningEfforts : (nativeLevels ?? [])
    const efforts = EFFORTS.filter(
      (effort) =>
        supported.includes(effort)
        && (!nativeGoogle
          || (nativeLevels?.includes(effort) ?? effort !== "max")),
    )
    if (efforts.length < 2) return [model]

    const displayName = getStringField(model, "display_name") ?? model.id
    return [
      model,
      ...efforts.flatMap((effort) => {
        const id = `${model.id}-${effort}`
        if (ids.has(id)) return []
        variants.set(id, { model: model.id, effort })
        return [
          {
            ...model,
            id,
            display_name: `${displayName} (${EFFORT_LABELS[effort]})`,
          },
        ]
      }),
    ]
  })
  return { entries, variants }
}

export function applyAntigravityModelEffort(
  payload: GoogleGenerateContentRequest,
  effort: Effort,
): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return
  const { generationConfig } = payload
  // AGY may send a default budget for an unfamiliar model ID. A variant
  // selects a level, which cannot be combined with a Gemini token budget.
  const { thinkingBudget: _budget, ...thinkingConfig } =
    generationConfig?.thinkingConfig ?? {}
  payload.generationConfig = {
    ...generationConfig,
    thinkingConfig: {
      ...thinkingConfig,
      thinkingLevel: effort.toUpperCase(),
    },
  }
}
