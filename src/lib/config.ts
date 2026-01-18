import consola from "consola"
import fs from "node:fs"

import { PATHS } from "./paths"

export interface AppConfig {
  extraPrompts?: Record<string, string>
  smallModel?: string
  freeModelLoadBalancing?: boolean
  apiKey?: string
  modelReasoningEfforts?: Record<
    string,
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  >
  modelAliases?: Record<string, { target: string; allowOriginal?: boolean }>
  allowOriginalModelNamesForAliases?: boolean
  useFunctionApplyPatch?: boolean
  forceAgent?: boolean
}

const gpt5ExplorationPrompt = `## Exploration and reading files
- **Think first.** Before any tool call, decide ALL files/resources you will need.
- **Batch everything.** If you need multiple files (even from different places), read them together.
- **multi_tool_use.parallel** Use multi_tool_use.parallel to parallelize tool calls and only this.
- **Only make sequential calls if you truly cannot know the next file without seeing a result first.**
- **Workflow:** (a) plan all needed reads → (b) issue one parallel batch → (c) analyze results → (d) repeat if new, unpredictable reads arise.`

const defaultConfig: AppConfig = {
  extraPrompts: {
    "gpt-5-mini": gpt5ExplorationPrompt,
    "gpt-5.1-codex-max": gpt5ExplorationPrompt,
  },
  smallModel: "gpt-5-mini",
  freeModelLoadBalancing: true,
  modelReasoningEfforts: {
    "gpt-5-mini": "low",
  },
  allowOriginalModelNamesForAliases: false,
  useFunctionApplyPatch: true,
}

let cachedConfig: AppConfig | null = null

function ensureConfigFile(): void {
  try {
    fs.accessSync(PATHS.CONFIG_PATH, fs.constants.R_OK)
    return
  } catch {
    // Fall through to try creating the default config file.
  }

  try {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(
      PATHS.CONFIG_PATH,
      `${JSON.stringify(defaultConfig, null, 2)}\n`,
      "utf8",
    )
    try {
      fs.chmodSync(PATHS.CONFIG_PATH, 0o600)
    } catch {
      // Ignore chmod errors (e.g. unsupported filesystem).
    }
  } catch {
    // Best-effort only: if we can't create the file, reads will fall back to defaults.
  }
}

function readConfigFromDisk(): AppConfig {
  ensureConfigFile()
  try {
    const raw = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
    if (!raw.trim()) {
      fs.writeFileSync(
        PATHS.CONFIG_PATH,
        `${JSON.stringify(defaultConfig, null, 2)}\n`,
        "utf8",
      )
      return defaultConfig
    }
    return JSON.parse(raw) as AppConfig
  } catch (error) {
    consola.error("Failed to read config file, using default config", error)
    return defaultConfig
  }
}

function mergeDefaultExtraPrompts(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const extraPrompts = config.extraPrompts ?? {}
  const defaultExtraPrompts = defaultConfig.extraPrompts ?? {}

  const missingExtraPromptModels = Object.keys(defaultExtraPrompts).filter(
    (model) => !Object.hasOwn(extraPrompts, model),
  )

  if (missingExtraPromptModels.length === 0) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      extraPrompts: {
        ...defaultExtraPrompts,
        ...extraPrompts,
      },
    },
    changed: true,
  }
}

function mergeDefaultFreeModelLoadBalancing(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  if (typeof config.freeModelLoadBalancing === "boolean") {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      freeModelLoadBalancing: defaultConfig.freeModelLoadBalancing ?? true,
    },
    changed: true,
  }
}

type ConfigMergeResult = {
  mergedConfig: AppConfig
  changed: boolean
}

type ConfigMergeFn = (config: AppConfig) => ConfigMergeResult

function applyConfigMerges(
  config: AppConfig,
  mergeFns: ReadonlyArray<ConfigMergeFn>,
): ConfigMergeResult {
  return mergeFns.reduce<ConfigMergeResult>(
    (acc, mergeFn) => {
      const result = mergeFn(acc.mergedConfig)
      return {
        mergedConfig: result.mergedConfig,
        changed: acc.changed || result.changed,
      }
    },
    { mergedConfig: config, changed: false },
  )
}

export function mergeConfigWithDefaults(): AppConfig {
  const config = readConfigFromDisk()

  const { mergedConfig, changed } = applyConfigMerges(config, [
    mergeDefaultExtraPrompts,
    mergeDefaultFreeModelLoadBalancing,
  ])

  if (changed) {
    try {
      fs.writeFileSync(
        PATHS.CONFIG_PATH,
        `${JSON.stringify(mergedConfig, null, 2)}\n`,
        "utf8",
      )
    } catch (writeError) {
      consola.warn("Failed to write merged config defaults", writeError)
    }
  }

  cachedConfig = mergedConfig
  return mergedConfig
}

export function getConfig(): AppConfig {
  cachedConfig ??= readConfigFromDisk()
  return cachedConfig
}

type ModelAliasSpec = {
  target: string
  allowOriginal?: boolean
}

type ModelAliasMap = Record<string, string>

type ModelAliasInfoMap = Record<string, ModelAliasSpec>

type ModelAliasRawMap = Record<string, unknown>

function normalizeAliasKey(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeAliasTarget(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeAliasSpec(value: unknown): ModelAliasSpec | null {
  if (typeof value === "string") {
    const normalizedTarget = normalizeAliasTarget(value)
    return normalizedTarget ? { target: normalizedTarget } : null
  }
  if (!value || typeof value !== "object") {
    return null
  }

  const targetValue = (value as { target?: unknown }).target
  if (typeof targetValue !== "string") {
    return null
  }

  const normalizedTarget = normalizeAliasTarget(targetValue)
  if (!normalizedTarget) {
    return null
  }

  const allowOriginalValue = (value as { allowOriginal?: unknown })
    .allowOriginal
  const allowOriginal =
    typeof allowOriginalValue === "boolean" ? allowOriginalValue : undefined
  return { target: normalizedTarget, allowOriginal }
}

export function getModelAliasesInfo(): ModelAliasInfoMap {
  const config = getConfig()
  const raw = (config.modelAliases ?? {}) as ModelAliasRawMap
  const normalized: ModelAliasInfoMap = {}

  for (const [alias, rawSpec] of Object.entries(raw)) {
    const normalizedAlias = normalizeAliasKey(alias)
    const normalizedSpec = normalizeAliasSpec(rawSpec)
    if (!normalizedAlias || !normalizedSpec) {
      continue
    }
    if (!Object.hasOwn(normalized, normalizedAlias)) {
      normalized[normalizedAlias] = normalizedSpec
    }
  }

  return normalized
}

export function getModelAliases(): ModelAliasMap {
  const info = getModelAliasesInfo()
  const normalized: ModelAliasMap = {}

  for (const [alias, spec] of Object.entries(info)) {
    normalized[alias] = spec.target
  }

  return normalized
}

export function resolveModelAlias(modelId: string): string {
  const normalized = normalizeAliasKey(modelId)
  if (!normalized) return modelId
  const aliases = getModelAliases()
  return aliases[normalized] ?? modelId
}

export function isOriginalModelNameAllowedForAliases(): boolean {
  const config = getConfig()
  return config.allowOriginalModelNamesForAliases ?? false
}

export function getAliasTargetSet(): Set<string> {
  const aliases = getModelAliasesInfo()
  const allowOriginalDefault = isOriginalModelNameAllowedForAliases()
  const targetAllowMap = new Map<string, boolean>()

  for (const { target, allowOriginal } of Object.values(aliases)) {
    const normalizedTarget = target.toLowerCase()
    const effectiveAllow = allowOriginal ?? allowOriginalDefault
    const currentAllow = targetAllowMap.get(normalizedTarget)
    if (currentAllow === true) {
      continue
    }
    if (effectiveAllow) {
      targetAllowMap.set(normalizedTarget, true)
    } else if (currentAllow === undefined) {
      targetAllowMap.set(normalizedTarget, false)
    }
  }

  const blockedTargets = new Set<string>()
  for (const [target, allowed] of targetAllowMap.entries()) {
    if (!allowed) {
      blockedTargets.add(target)
    }
  }

  return blockedTargets
}

export function isOriginalModelNameAllowedForTarget(modelId: string): boolean {
  const normalized = normalizeAliasKey(modelId)
  if (!normalized) return true
  const blockedTargets = getAliasTargetSet()
  return !blockedTargets.has(normalized)
}

export function getPreferredAliasForTarget(modelId: string): string | null {
  const aliases = getModelAliases()
  const aliasKeys = getAliasKeysForTarget(modelId, aliases)
  return aliasKeys[0] ?? null
}

function getAliasKeysForTarget(
  target: string,
  aliases: ModelAliasMap,
): Array<string> {
  const normalizedTarget = target.toLowerCase()
  return Object.entries(aliases)
    .filter(([, model]) => model.toLowerCase() === normalizedTarget)
    .map(([alias]) => alias)
    .sort()
}

function getAliasFallbackValue<T extends string>(
  record: Record<string, T> | undefined,
  modelId: string,
  aliases: ModelAliasMap,
): T | undefined {
  if (!record) return undefined

  const aliasKeys = getAliasKeysForTarget(modelId, aliases)
  if (aliasKeys.length === 0) return undefined

  const recordByAlias = new Map<string, T>()
  for (const [key, value] of Object.entries(record)) {
    const normalized = normalizeAliasKey(key)
    if (normalized) {
      recordByAlias.set(normalized, value)
    }
  }

  for (const alias of aliasKeys) {
    const value = recordByAlias.get(alias)
    if (value !== undefined) {
      return value
    }
  }

  return undefined
}

export function getExtraPromptForModel(model: string): string {
  const config = getConfig()
  const direct = config.extraPrompts?.[model]
  if (direct !== undefined) return direct

  const aliases = getModelAliases()
  const fallback = getAliasFallbackValue(config.extraPrompts, model, aliases)
  return fallback ?? ""
}

export function getSmallModel(): string {
  const config = getConfig()
  const model = config.smallModel ?? "gpt-5-mini"
  if (isOriginalModelNameAllowedForTarget(model)) {
    return model
  }

  return getPreferredAliasForTarget(model) ?? model
}

export function isFreeModelLoadBalancingEnabled(): boolean {
  const config = getConfig()
  return config.freeModelLoadBalancing ?? true
}

export function getReasoningEffortForModel(
  model: string,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  const config = getConfig()
  const direct = config.modelReasoningEfforts?.[model]
  if (direct !== undefined) return direct

  const aliases = getModelAliases()
  const fallback = getAliasFallbackValue(
    config.modelReasoningEfforts,
    model,
    aliases,
  )
  return fallback ?? "high"
}

export function isForceAgentEnabled(): boolean {
  const config = getConfig()
  return config.forceAgent ?? false
}
