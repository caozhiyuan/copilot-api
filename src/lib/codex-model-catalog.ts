import type {
  CodexModel,
  CodexModelMessages,
  CodexModelsResponse,
} from "~/routes/models/codex-models-types"

import { FULL_MODEL_CATALOG_HEADER } from "./internal-headers"

export const CODEX_MODEL_CATALOG_MAX_BYTES = 1024 * 1024
const DEFAULT_EXCLUSION_THRESHOLD = 20
const DEFAULT_EXCLUDED_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "claude-sonnet-5",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "gpt-5.4",
  "grok-4.5",
  "gpt-5-mini",
  "mai-code-1.1-flash",
])

export function isModernCodexClient(url: string, headers: Headers): boolean {
  const versions = [
    new URL(url).searchParams.get("client_version"),
    headers.get("version"),
    headers.get("user-agent")?.match(/\bcodex[^/\s]*\/(\d+\.\d+\.\d+)/iu)?.[1],
  ]
  for (const version of versions) {
    const match = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u)
    if (!match) continue
    return Number(match[1]) > 0 || Number(match[2]) >= 160
  }
  return false
}

export function normalizeCodexInstructions(
  model: CodexModel,
  modern: boolean,
  fallback: CodexModelMessages,
): CodexModel {
  if (!modern) return model
  const { base_instructions: legacy, ...normalized } = model
  const messages = model.model_messages
  if (typeof messages?.instructions_template !== "string") {
    normalized.model_messages = {
      ...(messages ?? fallback),
      instructions_template:
        typeof legacy === "string" ? legacy : fallback.instructions_template,
    }
  }
  return normalized
}

export function serializeCodexModelCatalog(
  response: CodexModelsResponse,
  options: {
    headers: Headers
    modern: boolean
    explicitSlugs: ReadonlySet<string>
    fallback: CodexModelMessages
  },
): string | null {
  const models = response.models.map((model) =>
    normalizeCodexInstructions(model, options.modern, options.fallback),
  )
  if (
    options.headers.get(FULL_MODEL_CATALOG_HEADER)?.trim().toLowerCase()
    === "true"
  ) {
    return JSON.stringify({ ...response, models })
  }
  // Measure the exact JSON envelope, including unknown upstream metadata.
  const envelope = JSON.stringify({ ...response, models: [] })
  let bytes = Buffer.byteLength(envelope, "utf8")
  if (bytes > CODEX_MODEL_CATALOG_MAX_BYTES) return null
  const selected = new Set<CodexModel>()
  const eligibleModels =
    models.length > DEFAULT_EXCLUSION_THRESHOLD ?
      models.filter(
        (model) =>
          options.explicitSlugs.has(model.slug)
          || !DEFAULT_EXCLUDED_MODELS.has(
            model.slug.split("/").at(-1) ?? model.slug,
          ),
      )
    : models
  const ordered = [...eligibleModels].sort(
    (a, b) =>
      Number(options.explicitSlugs.has(b.slug))
      - Number(options.explicitSlugs.has(a.slug)),
  )
  for (const model of ordered) {
    const additionalBytes =
      Buffer.byteLength(JSON.stringify(model), "utf8")
      + (selected.size > 0 ? 1 : 0)
    if (bytes + additionalBytes > CODEX_MODEL_CATALOG_MAX_BYTES) continue
    selected.add(model)
    bytes += additionalBytes
  }
  return JSON.stringify({
    ...response,
    models: models.filter((model) => selected.has(model)),
  })
}
