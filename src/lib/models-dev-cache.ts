import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import type {
  Cost as ModelsDevCost,
  Model as ModelsDevModel,
  ModelCost as ModelsDevModelCost,
  ProviderMap as ModelsDevProviderMap,
} from "@opencode-ai/models"
import consola from "consola"

import type {
  BuiltinProviderInputModality,
  BuiltinProviderModelConfig,
} from "./builtin-provider-models"
import type {
  CodexReasoningEffort,
  ModelReasoningField,
  ProviderType,
} from "./config-store"
import { PATHS } from "./paths"
import type {
  TokenUsagePricingConfig,
  TokenUsagePricingTier,
} from "./token-usage/pricing"

const MODELS_DEV_URL = "https://models.dev/api.json"
const REFRESH_INTERVAL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 15_000
const OPENCODE_GO = "opencode-go"
const MIN_RELEASE_DATE = Date.parse("2026-05-01")
const REASONING_EFFORTS = new Set<CodexReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
])

interface ModelRecord {
  [key: string]: string | number | Array<string> | undefined
  id: string
  name: string
  object: "model"
  created: number
  owned_by: string
  context_window?: number
  max_output_tokens?: number
  input_modalities?: Array<BuiltinProviderInputModality>
  reasoning_efforts?: Array<CodexReasoningEffort>
}
type ModelsDevFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

interface CatalogSnapshot {
  catalog: ModelsDevProviderMap
  configs: Record<string, BuiltinProviderModelConfig>
  providerTypes: Record<string, ProviderType>
  records: Array<ModelRecord>
  modelOutputTokens: Record<string, Record<string, number>>
  selectableProviders: Array<ModelsDevProviderOption>
  selectableProviderModelTypes: Record<string, Record<string, ProviderType>>
  selectableProviderModelApis: Record<string, Record<string, string>>
}

export interface ModelsDevProviderOption {
  id: string
  name: string
  api: string
  type: ProviderType
}

interface ResponseValidator {
  etag?: string
  lastModified?: string
}

export interface ModelsDevCacheOptions {
  cachePath?: string
  fetcher?: ModelsDevFetcher
  intervalMs?: number
}

let snapshot: CatalogSnapshot | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let refreshGeneration = 0
let responseValidator: ResponseValidator | null = null
let cachedBodyHash: string | null = null
let activeCachePath: string | null = null
let refreshAbortController: AbortController | null = null
let activeRefresh: Promise<void> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isVisibleModel(model: unknown): model is ModelsDevModel {
  if (!isRecord(model) || model.status === "deprecated") return false
  const releaseDate =
    typeof model.release_date === "string" ?
      Date.parse(model.release_date)
    : NaN
  return !(releaseDate < MIN_RELEASE_DATE)
}

function getMetadataPath(cachePath: string): string {
  const extension = path.extname(cachePath)
  return path.join(
    path.dirname(cachePath),
    `${path.basename(cachePath, extension)}.meta.json`,
  )
}

function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex")
}

function nonNegativeNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ?
      value
    : undefined
}

function positiveNumber(value: number | undefined): number | undefined {
  const number = nonNegativeNumber(value)
  return number && number > 0 ? number : undefined
}

function mapPriceTier(value: ModelsDevCost): TokenUsagePricingTier {
  const input = nonNegativeNumber(value.input)
  const output = nonNegativeNumber(value.output)
  const cachedInput = nonNegativeNumber(value.cache_read)
  const cacheCreationInput = nonNegativeNumber(value.cache_write)
  return {
    ...(input !== undefined && { input }),
    ...(output !== undefined && { output }),
    ...(cachedInput !== undefined && { cachedInput }),
    ...(cacheCreationInput !== undefined && { cacheCreationInput }),
  }
}

function mapPricing(
  value: ModelsDevModelCost | undefined,
): TokenUsagePricingConfig | undefined {
  if (!isRecord(value)) return undefined

  const base = mapPriceTier(value)
  const higherTiers = (Array.isArray(value.tiers) ? value.tiers : [])
    .flatMap((tier) => {
      const threshold = positiveNumber(tier?.tier?.size)
      return threshold && threshold >= 1 && tier.tier.type === "context" ?
          [{ threshold, price: mapPriceTier(tier) }]
        : []
    })
    .sort((a, b) => a.threshold - b.threshold)

  if (higherTiers.length === 0) return base

  const firstTierMax = Math.ceil(higherTiers[0].threshold) - 1
  const tiers: Array<TokenUsagePricingTier> = [
    ...(firstTierMax > 0 ? [{ ...base, maxInputTokens: firstTierMax }] : []),
    ...higherTiers.map((tier, index) => ({
      ...tier.price,
      ...(higherTiers[index + 1] && {
        maxInputTokens: Math.ceil(higherTiers[index + 1].threshold) - 1,
      }),
    })),
  ]
  return { tiers }
}

function mapReasoningEfforts(
  value: ModelsDevModel["reasoning_options"],
): Array<CodexReasoningEffort> {
  if (!Array.isArray(value)) return []
  const efforts: Array<string | null> = []
  for (const option of value) {
    if (option?.type === "effort" && Array.isArray(option.values)) {
      efforts.push(...option.values)
    }
  }
  return [
    ...new Set(
      efforts.filter(
        (effort): effort is CodexReasoningEffort =>
          typeof effort === "string"
          && REASONING_EFFORTS.has(effort as CodexReasoningEffort),
      ),
    ),
  ]
}

function mapInputModalities(
  value: ModelsDevModel["modalities"],
): Array<BuiltinProviderInputModality> {
  if (!isRecord(value) || !Array.isArray(value.input)) return []
  return [
    ...new Set(
      value.input.filter(
        (modality): modality is BuiltinProviderInputModality =>
          modality === "text" || modality === "image",
      ),
    ),
  ]
}

function mapReasoningField(
  model: ModelsDevModel,
): ModelReasoningField | undefined {
  const interleaved = model.interleaved
  const field = isRecord(interleaved) ? interleaved.field : interleaved
  if (field === "reasoning_content") return field
  // models.dev omits `interleaved` for the Hy family, whose Chat Completions
  // history expects the OpenRouter-style `reasoning` field.
  if (model.family === "Hy") return "reasoning"
  return undefined
}

function mapModelConfig(model: ModelsDevModel): BuiltinProviderModelConfig {
  const contextWindow = positiveNumber(model.limit?.context)
  const maxOutputTokens = positiveNumber(model.limit?.output)
  const reasoningEfforts = mapReasoningEfforts(model.reasoning_options)
  const inputModalities = mapInputModalities(model.modalities)
  const reasoningField = mapReasoningField(model)
  const pricing = mapPricing(model.cost)
  return {
    ...(contextWindow && { contextWindow }),
    ...(maxOutputTokens && { maxOutputTokens }),
    ...(inputModalities.length > 0 && { inputModalities }),
    ...(reasoningEfforts.length > 0 && { reasoningEfforts }),
    ...(reasoningField && { reasoningField }),
    ...(pricing && { pricing }),
  }
}

function mapModelRecord(
  provider: string,
  id: string,
  model: ModelsDevModel,
  config = mapModelConfig(model),
): ModelRecord {
  return {
    id,
    name: typeof model.name === "string" && model.name.trim() ? model.name : id,
    object: "model",
    created: 0,
    owned_by: provider,
    ...(config.contextWindow && { context_window: config.contextWindow }),
    ...(config.maxOutputTokens && {
      max_output_tokens: config.maxOutputTokens,
    }),
    ...(config.inputModalities && { input_modalities: config.inputModalities }),
    ...(config.reasoningEfforts && {
      reasoning_efforts: config.reasoningEfforts,
    }),
  }
}

function mapProviderType(
  model: ModelsDevModel,
  providerNpm: string | undefined,
): ProviderType {
  switch (model.provider?.npm || providerNpm) {
    case "@ai-sdk/anthropic":
      return "anthropic"
    case "@ai-sdk/openai":
      return model.provider?.shape === "completions" ?
          "openai-compatible"
        : "openai-responses"
    case "@ai-sdk/openai-compatible":
    default:
      return "openai-compatible"
  }
}

function normalizeCatalogApi(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("${")) return undefined
  const api = value.trim().replace(/\/+$/u, "")
  let url: URL
  try {
    url = new URL(api)
  } catch {
    return undefined
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    return undefined
  }
  return api
}

function parseSelectableProviders(
  data: Record<string, unknown>,
): Pick<
  CatalogSnapshot,
  | "selectableProviders"
  | "selectableProviderModelTypes"
  | "selectableProviderModelApis"
> {
  const selectableProviders: Array<ModelsDevProviderOption> = []
  const selectableProviderModelTypes: Record<
    string,
    Record<string, ProviderType>
  > = Object.create(null) as Record<string, Record<string, ProviderType>>
  const selectableProviderModelApis: Record<
    string,
    Record<string, string>
  > = Object.create(null) as Record<string, Record<string, string>>

  for (const [id, value] of Object.entries(data)) {
    if (
      id === "openrouter"
      || id === "github-copilot"
      || id === "opencode-go"
      || id === "copilot"
      || id === "codex"
      || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id)
      || !isRecord(value)
      || (value.npm !== "@ai-sdk/openai-compatible"
        && value.npm !== "@ai-sdk/openai"
        && value.npm !== "@ai-sdk/anthropic")
    ) {
      continue
    }

    const api = normalizeCatalogApi(value.api)
    if (!api) continue

    selectableProviders.push({
      id,
      name:
        typeof value.name === "string" && value.name.trim() ?
          value.name.trim()
        : id,
      api,
      type:
        value.npm === "@ai-sdk/openai" ? "openai-responses"
        : value.npm === "@ai-sdk/anthropic" ? "anthropic"
        : "openai-compatible",
    })

    const modelTypes: Record<string, ProviderType> = Object.create(
      null,
    ) as Record<string, ProviderType>
    const modelApis: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >
    if (isRecord(value.models)) {
      for (const [modelId, model] of Object.entries(value.models)) {
        if (!isVisibleModel(model)) continue
        const modelProvider = isRecord(model.provider) ? model.provider : null
        const modelNpm = modelProvider?.npm ?? value.npm
        if (
          modelNpm !== "@ai-sdk/openai-compatible"
          && modelNpm !== "@ai-sdk/openai"
          && modelNpm !== "@ai-sdk/anthropic"
        ) {
          continue
        }
        const type = mapProviderType(model, value.npm)
        modelTypes[modelId] = type
        const modelApi = normalizeCatalogApi(modelProvider?.api)
        if (modelApi) modelApis[modelId] = modelApi
      }
    }
    selectableProviderModelTypes[id] = modelTypes
    selectableProviderModelApis[id] = modelApis
  }

  selectableProviders.sort(
    (a, b) =>
      a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"),
  )
  return {
    selectableProviders,
    selectableProviderModelTypes,
    selectableProviderModelApis,
  }
}

function parseModelOutputTokens(
  data: Record<string, unknown>,
): CatalogSnapshot["modelOutputTokens"] {
  const providers = Object.create(null) as CatalogSnapshot["modelOutputTokens"]
  for (const [providerId, provider] of Object.entries(data)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue
    const models = Object.create(null) as Record<string, number>
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!isVisibleModel(model)) continue
      const output = positiveNumber(model.limit?.output)
      if (output !== undefined && Number.isInteger(output)) {
        models[modelId] = output
      }
    }
    providers[providerId] = models
  }
  return providers
}

function parseCatalog(data: unknown): CatalogSnapshot {
  const provider = isRecord(data) ? data[OPENCODE_GO] : undefined
  const models = isRecord(provider) ? provider.models : undefined
  if (!isRecord(models)) {
    throw new Error("models.dev response has no opencode-go models")
  }
  const providerNpm =
    isRecord(provider) && typeof provider.npm === "string" ?
      provider.npm
    : undefined

  const configs: Record<string, BuiltinProviderModelConfig> = Object.create(
    null,
  ) as Record<string, BuiltinProviderModelConfig>
  const providerTypes: Record<string, ProviderType> = Object.create(
    null,
  ) as Record<string, ProviderType>
  const records: Array<ModelRecord> = []
  const typedModels = models as ModelsDevProviderMap[string]["models"]
  for (const id of Object.keys(typedModels).sort()) {
    const value = typedModels[id]
    if (!id.trim() || !isVisibleModel(value) || value.id !== id) continue
    const config = mapModelConfig(value)
    configs[id] = config
    providerTypes[id] = mapProviderType(value, providerNpm)
    records.push(mapModelRecord(OPENCODE_GO, id, value, config))
  }

  if (records.length === 0) {
    throw new Error("models.dev response has no valid opencode-go models")
  }
  return {
    catalog: data as ModelsDevProviderMap,
    configs,
    providerTypes,
    records,
    modelOutputTokens: parseModelOutputTokens(data as Record<string, unknown>),
    ...parseSelectableProviders(data as Record<string, unknown>),
  }
}

export function installModelsDevCatalog(data: unknown): number {
  snapshot = parseCatalog(data)
  return snapshot.records.length
}

export function getOpencodeGoModelIds(): Array<string> {
  return snapshot?.records.map((model) => model.id) ?? []
}

export function getOpencodeGoModelConfig(
  modelId: string,
): BuiltinProviderModelConfig | undefined {
  return (
    snapshot?.configs[modelId.trim()]
    ?? snapshot?.configs[modelId.trim().toLowerCase()]
  )
}

export function getOpencodeGoModelProviderType(modelId: string): ProviderType {
  const id = modelId.trim()
  return (
    snapshot?.providerTypes[id]
    ?? snapshot?.providerTypes[id.toLowerCase()]
    ?? "openai-compatible"
  )
}

export function getOpencodeGoModelRecords(): Array<ModelRecord> {
  return snapshot?.records ?? []
}

export function getModelsDevProviderModelRecords(
  providerId: string,
): Array<ModelRecord> {
  const models = snapshot?.catalog[providerId]?.models
  if (!isRecord(models)) return []

  return Object.keys(models)
    .sort()
    .flatMap((id) => {
      const model = models[id]
      if (!id.trim() || !isVisibleModel(model) || model.id !== id) {
        return []
      }
      return [mapModelRecord(providerId, id, model)]
    })
}

export function getModelsDevProviderOptions(): Array<ModelsDevProviderOption> {
  return snapshot?.selectableProviders ?? []
}

export function getModelsDevModelConfig(
  providerId: string,
  modelId: string,
): BuiltinProviderModelConfig | undefined {
  const model = getModelsDevModel(providerId, modelId)
  return isVisibleModel(model) ? mapModelConfig(model) : undefined
}

export function isModelsDevModelVisible(
  providerId: string,
  modelId: string,
): boolean {
  const model = getModelsDevModel(providerId, modelId)
  return model === undefined || isVisibleModel(model)
}

export function getModelsDevProviderModelIds(
  providerId: string,
): Array<string> {
  return getModelsDevProviderModelRecords(providerId).map((model) => model.id)
}

export async function loadCachedModelsDevCatalog(): Promise<void> {
  if (!snapshot) {
    await loadDiskCache(
      activeCachePath ?? path.join(PATHS.APP_DIR, "models-dev-api.json"),
    )
  }
}

export function getModelsDevProviderApi(
  providerId: string,
): string | undefined {
  return snapshot?.selectableProviders.find(
    (provider) => provider.id === providerId,
  )?.api
}

export function getModelsDevModelProviderType(
  providerId: string,
  modelId: string,
): ProviderType | undefined {
  return snapshot?.selectableProviderModelTypes[providerId]?.[modelId]
}

export function getModelsDevModelApi(
  providerId: string,
  modelId: string,
): string | undefined {
  return snapshot?.selectableProviderModelApis[providerId]?.[modelId]
}

export function getModelsDevModelPricing(
  providerId: string,
  modelId: string,
): TokenUsagePricingConfig | undefined {
  return getModelsDevModelConfig(providerId, modelId)?.pricing
}

export function getModelsDevModel(
  providerId: string,
  modelId: string,
): ModelsDevModel | undefined {
  const model = snapshot?.catalog[providerId]?.models?.[modelId]
  return isRecord(model) ? model : undefined
}

export function getModelsDevModelMaxOutputTokens(
  providerId: string,
  modelId: string,
): number | undefined {
  return snapshot?.modelOutputTokens[providerId]?.[modelId]
}

export async function loadModelsDevProviderOptions(): Promise<
  Array<ModelsDevProviderOption>
> {
  if (!snapshot) {
    const cachePath =
      activeCachePath ?? path.join(PATHS.APP_DIR, "models-dev-api.json")
    await loadDiskCache(cachePath)
    if (!snapshot) {
      await refreshCatalog(
        cachePath,
        fetch,
        new AbortController().signal,
        refreshGeneration,
      )
      activeCachePath = cachePath
    }
  }
  return getModelsDevProviderOptions()
}

export async function stopModelsDevRefreshLoop(): Promise<void> {
  refreshGeneration += 1
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = null
  refreshAbortController?.abort()
  await activeRefresh?.catch(() => undefined)
  activeRefresh = null
}

async function loadDiskCache(cachePath: string): Promise<void> {
  let body: string
  try {
    body = await fs.readFile(cachePath, "utf8")
    installModelsDevCatalog(JSON.parse(body))
    cachedBodyHash = hashBody(body)
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return
    consola.warn("Failed to load models.dev disk cache.", error)
    return
  }

  try {
    const metadata = JSON.parse(
      await fs.readFile(getMetadataPath(cachePath), "utf8"),
    ) as unknown
    if (isRecord(metadata) && metadata.sha256 === cachedBodyHash) {
      responseValidator = {
        etag:
          typeof metadata.etag === "string" && metadata.etag.trim() ?
            metadata.etag
          : undefined,
        lastModified:
          (
            typeof metadata.lastModified === "string"
            && metadata.lastModified.trim()
          ) ?
            metadata.lastModified
          : undefined,
      }
    }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return
    consola.warn("Failed to load models.dev cache metadata.", error)
  }
}

async function persistMetadata(
  cachePath: string,
  sha256: string,
  validator: ResponseValidator | null,
): Promise<void> {
  const metadataPath = getMetadataPath(cachePath)
  const temporaryPath = `${metadataPath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(
      temporaryPath,
      JSON.stringify({ sha256, ...validator }),
      { mode: 0o600 },
    )
    await fs.rename(temporaryPath, metadataPath)
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
}

async function persistCache(
  cachePath: string,
  body: string,
  sha256: string,
  validator: ResponseValidator | null,
): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true })
  const temporaryPath = `${cachePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporaryPath, body, { mode: 0o600 })
    await fs.rename(temporaryPath, cachePath)
    await persistMetadata(cachePath, sha256, validator)
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
}

async function refreshCatalog(
  cachePath: string,
  fetcher: ModelsDevFetcher,
  signal: AbortSignal,
  generation: number,
): Promise<void> {
  const headers = new Headers({ accept: "application/json" })
  if (snapshot && responseValidator?.etag) {
    headers.set("if-none-match", responseValidator.etag)
  } else if (snapshot && responseValidator?.lastModified) {
    headers.set("if-modified-since", responseValidator.lastModified)
  }
  const response = await fetcher(MODELS_DEV_URL, {
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
  })
  if (signal.aborted || generation !== refreshGeneration) return
  if (response.status === 304) {
    if (!snapshot) {
      throw new Error("models.dev returned HTTP 304 without a cached catalog")
    }
    responseValidator = {
      etag: response.headers.get("etag") ?? responseValidator?.etag,
      lastModified:
        response.headers.get("last-modified")
        ?? responseValidator?.lastModified,
    }
    if (cachedBodyHash) {
      try {
        await persistMetadata(cachePath, cachedBodyHash, responseValidator)
      } catch (error) {
        consola.warn("Failed to save models.dev cache metadata.", error)
      }
    }
    consola.debug("models.dev catalog is unchanged")
    return
  }
  if (!response.ok) {
    throw new Error(`models.dev returned HTTP ${response.status}`)
  }

  const body = await response.text()
  if (signal.aborted || generation !== refreshGeneration) return
  const nextSnapshot = parseCatalog(JSON.parse(body))
  snapshot = nextSnapshot
  cachedBodyHash = hashBody(body)
  responseValidator = {
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
  }
  try {
    await persistCache(cachePath, body, cachedBodyHash, responseValidator)
  } catch (error) {
    consola.warn("Failed to save models.dev disk cache.", error)
  }
  consola.debug(
    `Loaded ${nextSnapshot.records.length} OpenCode Go models from models.dev`,
  )
}

function scheduleRefresh(
  cachePath: string,
  fetcher: ModelsDevFetcher,
  intervalMs: number,
  generation: number,
): void {
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    activeRefresh = runRefresh(
      cachePath,
      fetcher,
      intervalMs,
      generation,
      false,
    )
  }, intervalMs)
}

async function runRefresh(
  cachePath: string,
  fetcher: ModelsDevFetcher,
  intervalMs: number,
  generation: number,
  required: boolean,
): Promise<void> {
  const controller = new AbortController()
  refreshAbortController = controller
  let refreshed = false
  try {
    await refreshCatalog(cachePath, fetcher, controller.signal, generation)
    refreshed = true
  } catch (error) {
    if (required) {
      throw new Error(
        `Failed to fetch initial models.dev catalog: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    if (generation === refreshGeneration && !controller.signal.aborted) {
      consola.warn(
        "Failed to refresh models.dev catalog; keeping cached models.",
        error,
      )
    }
  } finally {
    if (refreshAbortController === controller) refreshAbortController = null
    if (generation === refreshGeneration && (!required || refreshed)) {
      scheduleRefresh(cachePath, fetcher, intervalMs, generation)
    }
  }
}

export async function startModelsDevCache(
  options: ModelsDevCacheOptions = {},
): Promise<void> {
  await stopModelsDevRefreshLoop()
  responseValidator = null
  const generation = refreshGeneration
  const cachePath =
    options.cachePath ?? path.join(PATHS.APP_DIR, "models-dev-api.json")
  if (activeCachePath !== cachePath) {
    snapshot = null
    cachedBodyHash = null
  }
  activeCachePath = cachePath
  const fetcher = options.fetcher ?? fetch
  const intervalMs = options.intervalMs ?? REFRESH_INTERVAL_MS
  await loadDiskCache(cachePath)
  if (generation === refreshGeneration) {
    const required = snapshot === null
    activeRefresh = runRefresh(
      cachePath,
      fetcher,
      intervalMs,
      generation,
      required,
    )
    if (required) await activeRefresh
  }
}
