import type { Cost, CostTier, Limit, ModelCost } from "@opencode-ai/models"
import type { Context } from "hono"

import { builtinProviderModelRegistry } from "~/lib/builtin-provider-models"
import { getRawProviderConfig } from "~/lib/config"
import { getOpencodeModelContextWindow } from "~/lib/config-store"
import { GITHUB_COPILOT_PROVIDER } from "~/lib/github-copilot-provider"
import { stripInternalRequestHeaders } from "~/lib/internal-headers"
import { resolveModelPdfSupport } from "~/lib/model-pdf-support"
import { findEndpointModel } from "~/lib/models"
import type { Reasoning } from "~/lib/types/responses"
import {
  resolveProviderCurrency,
  type TokenUsagePricingConfig,
} from "~/lib/token-usage/pricing"
import {
  createModelListResponse,
  getAgentModels,
  getRecordField,
  getStringField,
  getStringList,
  type ClientModel,
} from "~/routes/models/model-discovery"
import { getModelMetadata } from "~/routes/models/model-metadata"

const RESPONSES_PACKAGE = "@opencode/ai/providers/openai/responses"
// OpenCode's cost schema is USD per million tokens. Configured CNY prices
// are converted with this fixed rate; other currencies are not returned as USD.
const CNY_PER_USD = 6.7
const COST_DECIMALS = 6

// OpenCode's v2 branch: packages/schema/src/model.ts (Model.Info).
export interface OpencodeModel {
  id: string
  modelID: string
  providerID: string
  name: string
  family?: string
  package: typeof RESPONSES_PACKAGE
  capabilities: { tools: boolean; input: Array<string>; output: Array<string> }
  variants: Array<{ id: string; body: Record<string, unknown> }>
  time: { released: number }
  cost: Array<OpencodeModelCost>
  status: "active" | "alpha" | "beta" | "deprecated"
  enabled: boolean
  limit: Limit
}

type OpencodeModelCost = Pick<Cost, "input" | "output"> & {
  cache: { read: number; write: number }
  tier?: CostTier["tier"]
}

export function isOpencodeUserAgent(userAgent: string | undefined): boolean {
  return /opencode/iu.test(userAgent ?? "")
}

// OpenCode only understands USD; convert the provider's currency into a
// multiplier applied to every mapped price. Unsupported currencies return
// undefined so the USD catalog can be used instead.
function resolveUsdRate(currency: string | null): number | undefined {
  if (currency === "USD") return 1
  if (currency === "CNY") return 1 / CNY_PER_USD
  return undefined
}

// Converted prices are rounded to six decimals.
function roundCost(value: number): number {
  const factor = 10 ** COST_DECIMALS
  return Math.round(value * factor) / factor
}

function mapCost(
  value: Cost,
  rate: number,
  tier?: CostTier["tier"],
): OpencodeModelCost {
  return {
    input: roundCost(value.input * rate),
    output: roundCost(value.output * rate),
    cache: {
      read: roundCost((value.cache_read ?? 0) * rate),
      write: roundCost((value.cache_write ?? 0) * rate),
    },
    ...(tier && { tier }),
  }
}

function mapCatalogCost(cost: ModelCost | undefined): Array<OpencodeModelCost> {
  if (!cost) return []
  // models.dev is external data; ignore a malformed `tiers` field instead of
  // failing model discovery.
  const tiers = Array.isArray(cost.tiers) ? cost.tiers : []
  return [
    mapCost(cost, 1),
    ...tiers.map((tier) => mapCost(tier, 1, tier.tier)),
    ...(tiers.length === 0 && cost.context_over_200k ?
      [mapCost(cost.context_over_200k, 1, { type: "context", size: 200_001 })]
    : []),
  ]
}

function mapConfiguredCost(
  pricing: TokenUsagePricingConfig,
  rate: number,
): Array<OpencodeModelCost> {
  const tiers = [...(pricing.tiers?.length ? pricing.tiers : [pricing])].sort(
    (a, b) => (a.maxInputTokens ?? Infinity) - (b.maxInputTokens ?? Infinity),
  )
  return tiers.map((tier, index) =>
    mapCost(
      {
        input: tier.input ?? pricing.input ?? 0,
        output: tier.output ?? pricing.output ?? 0,
        cache_read: tier.cachedInput ?? pricing.cachedInput,
        cache_write: tier.cacheCreationInput ?? pricing.cacheCreationInput,
      },
      rate,
      index > 0 ?
        { type: "context", size: (tiers[index - 1].maxInputTokens ?? 0) + 1 }
      : undefined,
    ),
  )
}

// Variant bodies go to the gateway's Responses endpoint. Keep its supported
// reasoning.effort values and drop unknown catalog values such as "default".
const RESPONSES_EFFORTS = new Set<string>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] satisfies Array<NonNullable<Reasoning["effort"]>>)

function normalizeEffortValues(
  values: Array<string> | undefined,
): Array<string> {
  const efforts = (values ?? []).filter((value) => RESPONSES_EFFORTS.has(value))
  return [...new Set(efforts)]
}

function toOpencodeModel(
  model: ClientModel,
  contextWindow: number,
): OpencodeModel {
  const separator = model.id.indexOf("/")
  const provider =
    separator < 0 ? GITHUB_COPILOT_PROVIDER : model.id.slice(0, separator)
  const rawId =
    separator < 0 ?
      (findEndpointModel(model.id)?.id ?? model.id)
    : model.id.slice(separator + 1)
  const config = getRawProviderConfig(provider)
  const metadata = getModelMetadata(provider, rawId, model, config)
  const { modelConfig, defaults, catalog, capabilities, supports, limits } =
    metadata
  const context = metadata.contextWindow ?? 256_000
  const inputLimit = metadata.inputLimit ?? 0
  const supportedMediaTypes = getStringList(
    getRecordField(limits, "vision")?.supported_media_types,
  )
  const supportPdf = resolveModelPdfSupport(provider, {
    supportPdf: modelConfig?.supportPdf,
    supportedMediaTypes,
    catalogInputModalities: catalog?.modalities?.input,
    builtinSupportPdf:
      defaults?.supportPdf
      ?? builtinProviderModelRegistry.getProviderDefaults(provider)?.supportPdf,
  })
  const input = metadata.inputModalities.filter(
    (modality) => modality !== "pdf" || supportPdf,
  )
  if (supportPdf && !input.includes("pdf")) input.push("pdf")
  const efforts = normalizeEffortValues(metadata.reasoningEfforts)
  // OpenCode's cost schema is USD-only; CNY prices are converted at the fixed
  // CNY_PER_USD rate, while unsupported currencies fall through to the USD
  // models.dev catalog.
  const configuredRate = resolveUsdRate(
    resolveProviderCurrency(provider, config?.pricingCurrency),
  )
  const builtinRate = resolveUsdRate(
    resolveProviderCurrency(provider, undefined),
  )
  const cost =
    modelConfig?.pricing && configuredRate !== undefined ?
      mapConfiguredCost(modelConfig.pricing, configuredRate)
    : catalog?.cost ? mapCatalogCost(catalog.cost)
    : defaults?.pricing && builtinRate !== undefined ?
      mapConfiguredCost(defaults.pricing, builtinRate)
    : []
  const released = Date.parse(catalog?.release_date ?? "")
  return {
    id: model.id,
    modelID: model.id,
    providerID: "local",
    name: getStringField(model, "display_name") ?? catalog?.name ?? model.id,
    family: catalog?.family ?? getStringField(capabilities ?? {}, "family"),
    package: RESPONSES_PACKAGE,
    capabilities: {
      tools:
        typeof supports?.tool_calls === "boolean" ?
          supports.tool_calls
        : (catalog?.tool_call ?? true),
      input: [...input],
      output: [...(catalog?.modalities?.output ?? ["text"])],
    },
    variants: efforts.map((effort) => ({
      id: effort,
      body: { reasoning: { effort } },
    })),
    time: { released: Number.isFinite(released) ? released : 0 },
    cost,
    status: catalog?.status ?? (model.preview ? "beta" : "active"),
    enabled: true,
    limit: {
      context: Math.min(context, contextWindow),
      ...(inputLimit > 0 && {
        input: Math.min(inputLimit, context, contextWindow),
      }),
      output: Math.min(context, metadata.maxOutputTokens ?? 32_000),
    },
  }
}

export async function handleOpencodeModels(c: Context): Promise<Response> {
  const models = await getAgentModels(
    stripInternalRequestHeaders(c.req.raw.headers),
  )
  const contextWindow = getOpencodeModelContextWindow()
  c.header("Cache-Control", "private, no-store")
  c.header("Vary", "User-Agent")
  return createModelListResponse(
    c,
    models.map((model) => toOpencodeModel(model, contextWindow)),
  )
}
