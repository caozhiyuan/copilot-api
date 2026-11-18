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

export function resolveCodexCatalogCompatibility(
  url: string,
  headers: Headers,
): { modern: boolean; supportsLargeCatalog: boolean } {
  const versions = [
    new URL(url).searchParams.getAll("client_version").at(-1),
    headers.get("version"),
    headers.get("user-agent")?.match(/\bcodex[^/\s]*\/([^\s()]+)/iu)?.[1],
  ]
  for (const version of versions) {
    const match = version?.match(
      /^(\d+)\.(\d+)\.(\d+)(-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/iu,
    )
    if (!match) continue
    const major = Number(match[1])
    const minor = Number(match[2])
    const patch = Number(match[3])
    const prerelease = match[4] !== undefined
    // https://github.com/openai/codex/pull/56525 shipped in Codex 0.166.0.
    return {
      modern: major > 0 || minor >= 160,
      supportsLargeCatalog:
        major > 0
        || minor > 166
        || (minor === 166 && (patch > 0 || !prerelease)),
    }
  }
  return { modern: false, supportsLargeCatalog: false }
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
    supportsLargeCatalog: boolean
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
  if (options.supportsLargeCatalog) {
    return JSON.stringify({ ...response, models: eligibleModels })
  }
  // Measure the exact JSON envelope, including unknown upstream metadata.
  const envelope = JSON.stringify({ ...response, models: [] })
  let bytes = Buffer.byteLength(envelope, "utf8")
  if (bytes > CODEX_MODEL_CATALOG_MAX_BYTES) return null
  const selected = new Set<CodexModel>()
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
