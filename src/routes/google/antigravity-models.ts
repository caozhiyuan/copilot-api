import { builtinProviderModelRegistry } from "~/lib/catalog/builtin-provider-models"
import { resolveModelPdfSupport } from "~/lib/catalog/model-pdf-support"
import { findEndpointModel } from "~/lib/catalog/models"
import { parseProviderModelAlias } from "~/lib/catalog/provider-model"
import {
  getRawProviderConfig,
  resolveEffectiveProviderType,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { getProviderAgentModels } from "~/lib/config/provider-management"
import { GITHUB_COPILOT_PROVIDER } from "~/lib/providers/github-copilot-provider"
import type { GoogleGenerateContentRequest } from "~/lib/types/google"
import {
  getRecordField,
  getStringField,
  type ClientModel,
} from "~/routes/models/model-discovery"
import { getModelMetadata } from "~/routes/models/model-metadata"

const EFFORT_LABELS = {
  // AGY selects the first listed variant when there is no base entry.
  medium: "Medium",
  low: "Low",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
} as const
type Effort = keyof typeof EFFORT_LABELS
const EFFORTS = Object.keys(EFFORT_LABELS) as Array<Effort>
const MEDIA_MODEL_PREFIX = "my-gemini-"

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

function getEffortBaseId(model: string): string | undefined {
  const effort = EFFORTS.find((level) => model.endsWith(`-${level}`))
  return effort ? model.slice(0, -effort.length - 1) : undefined
}

function getExistingEffortBaseId(
  model: string,
  models: ReadonlyMap<string, ClientModel>,
): string | undefined {
  const base = getEffortBaseId(model)
  return base && models.has(base) ? base : undefined
}

export function mayUseAntigravityModelAlias(model: string): boolean {
  return (
    model.slice(model.lastIndexOf("/") + 1).startsWith(MEDIA_MODEL_PREFIX)
    || getEffortBaseId(model) !== undefined
  )
}

function toMediaModelId(id: string): string {
  const modelStart = id.lastIndexOf("/") + 1
  return `${id.slice(0, modelStart)}${MEDIA_MODEL_PREFIX}${id.slice(modelStart)}`
}

function supportsAttachmentInputs(
  provider: string,
  metadata: ReturnType<typeof getModelMetadata>,
): boolean {
  const { catalog, defaults, inputModalities, limits, modelConfig } = metadata
  return (
    inputModalities.includes("image")
    && resolveModelPdfSupport(provider, {
      supportPdf: modelConfig?.supportPdf,
      catalogInputModalities: catalog?.modalities?.input,
      supportedMediaTypes: getRecordField(limits, "vision")
        ?.supported_media_types,
      builtinSupportPdf:
        defaults?.supportPdf
        ?? builtinProviderModelRegistry.getProviderDefaults(provider)
          ?.supportPdf,
    })
  )
}

function withMediaModelAliases(
  entries: Array<ClientModel>,
  modelsById: ReadonlyMap<string, ClientModel>,
  variants: ReadonlyMap<string, AntigravityModelVariant>,
  attachmentModels: ReadonlySet<string>,
) {
  const families = Map.groupBy(
    entries,
    ({ id }) =>
      variants.get(id)?.model ?? getExistingEffortBaseId(id, modelsById) ?? id,
  )
  const publicIds = new Map<string, string>()
  const mediaAliases = new Map<string, string>()
  for (const [baseId, family] of families) {
    if (!attachmentModels.has(baseId)) continue

    // Keep the family grouped in AGY and preserve provider-owned model IDs.
    const ids = new Set([baseId, ...family.map(({ id }) => id)])
    const aliases = Array.from(ids, (id) => ({ id, alias: toMediaModelId(id) }))
    if (
      aliases.some(
        ({ id, alias }) =>
          (!variants.has(id) && !attachmentModels.has(id))
          || modelsById.has(alias)
          || variants.has(alias),
      )
    ) {
      continue
    }

    for (const { id, alias } of aliases) {
      publicIds.set(id, alias)
      mediaAliases.set(alias, id)
    }
  }

  return {
    entries: entries.map((model) => {
      const id = publicIds.get(model.id)
      return id ?
          {
            ...model,
            id,
            display_name: getStringField(model, "display_name") ?? model.id,
          }
        : model
    }),
    mediaAliases,
  }
}

export function createAntigravityModelCatalog(
  models: Array<ClientModel>,
  getProviderConfig: (name: string) => ResolvedProviderConfig | null,
) {
  const modelsById = new Map(models.map((model) => [model.id, model]))
  const listedVariantIds = new Set<string>()
  const visibleModelIds = new Set<string>()
  const attachmentModels = new Set<string>()
  const variants = new Map<string, AntigravityModelVariant>()
  const entriesByModel = models.map((model) => {
    const alias = parseProviderModelAlias(model.id)
    const provider = alias ? getProviderConfig(alias.provider) : null
    const copilotModel = provider ? undefined : findEndpointModel(model.id)
    const providerName =
      provider?.name
      ?? (copilotModel ? GITHUB_COPILOT_PROVIDER : alias?.provider)
      ?? GITHUB_COPILOT_PROVIDER
    const modelId = copilotModel?.id ?? alias?.model ?? model.id
    const config = provider ?? getRawProviderConfig(providerName)
    const agentModels = getProviderAgentModels(config)
    if (
      agentModels === undefined
      || agentModels.includes(modelId)
      || (providerName === GITHUB_COPILOT_PROVIDER
        && agentModels.includes(model.id))
    ) {
      visibleModelIds.add(model.id)
    }

    const metadata = getModelMetadata(providerName, modelId, model, config)
    if (
      !model.id.includes("gemini-")
      && supportsAttachmentInputs(providerName, metadata)
    ) {
      attachmentModels.add(model.id)
    }

    // A provider-supplied variant belongs to its base model's group.
    if (getExistingEffortBaseId(model.id, modelsById)) return model

    const { reasoningEfforts } = metadata
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
    if (efforts.length < 2) return model

    const displayName = getStringField(model, "display_name") ?? model.id
    return efforts.map((effort) => {
      const id = `${model.id}-${effort}`
      const existing = modelsById.get(id)
      if (existing) {
        listedVariantIds.add(id)
        return existing
      }
      variants.set(id, { model: model.id, effort })
      return {
        ...model,
        id,
        display_name: `${displayName} (${EFFORT_LABELS[effort]})`,
      }
    })
  })
  const entries = entriesByModel.flatMap((entry) => {
    if (Array.isArray(entry)) return entry
    return listedVariantIds.has(entry.id) ? [] : [entry]
  })
  const catalog = withMediaModelAliases(
    entries,
    modelsById,
    variants,
    attachmentModels,
  )
  // Keep all aliases routable. The provider selection controls discovery.
  const visibleEntries = catalog.entries.filter(({ id }) => {
    const originalId = catalog.mediaAliases.get(id) ?? id
    return visibleModelIds.has(variants.get(originalId)?.model ?? originalId)
  })
  return {
    entries: visibleEntries,
    mediaAliases: catalog.mediaAliases,
    variants,
  }
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
