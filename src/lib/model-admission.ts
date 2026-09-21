import type { Context } from "hono"

/**
 * Stable client-facing error returned whenever a request selects a model that
 * is outside this distribution's supported model families.
 */
export const MODEL_NOT_ALLOWED_ERROR = {
  code: "model_not_allowed",
  message:
    "The selected model is not allowed. Only OpenAI and Microsoft MAI models are supported.",
  param: "model",
  type: "invalid_request_error",
} as const

/**
 * Raised by request handlers for the effective model selected after mappings
 * and any provider prefix are accounted for. `forwardError` turns this into
 * the stable 400 response above.
 */
export class ModelNotAllowedError extends Error {
  constructor() {
    super(MODEL_NOT_ALLOWED_ERROR.message)
    this.name = "ModelNotAllowedError"
  }
}

const OPENAI_MODEL_FAMILY_PATTERNS = [
  /^(?:chatgpt|codex|gpt)(?:[-_.]|$)/u,
  /^o\d+(?:[-_.]|$)/u,
  /^(?:computer-use|dall-e|omni-moderation|sora|text-embedding|text-moderation|tts|whisper)(?:[-_.]|$)/u,
  /^(?:ada|babbage|curie|davinci)(?:[-_.]|$)/u,
  /^(?:code|text)-(?:ada|babbage|curie|davinci)(?:[-_.]|$)/u,
]
const MAI_MODEL_FAMILY_PATTERN = /^mai(?:[-_.]|$)/u

/**
 * Normalize only for admission checks. The original identifier is preserved
 * for upstream routing because provider model IDs can be case-sensitive.
 */
export function normalizeModelIdForAdmission(modelId: string): string {
  return modelId.normalize("NFKC").trim().toLowerCase()
}

/**
 * Return the family-bearing portion of a provider-qualified model ID.
 *
 * Top-level aliases are resolved before this function is called, but provider
 * model IDs can themselves be namespaced (for example `openai/gpt-5.4`). The
 * last non-empty segment is therefore the authoritative family identifier.
 */
function getModelFamilyId(modelId: string): string {
  return modelId.split("/").filter(Boolean).at(-1) ?? ""
}

export function isAllowedModel(modelId: unknown): modelId is string {
  if (typeof modelId !== "string") return false

  const normalized = normalizeModelIdForAdmission(modelId)
  if (!normalized) return false

  const familyId = getModelFamilyId(normalized)
  return (
    MAI_MODEL_FAMILY_PATTERN.test(familyId)
    || OPENAI_MODEL_FAMILY_PATTERNS.some((pattern) => pattern.test(familyId))
  )
}

export function assertAllowedModel(
  modelId: unknown,
): asserts modelId is string {
  if (!isAllowedModel(modelId)) {
    throw new ModelNotAllowedError()
  }
}

export function assertAllowedModelSelection(payload: {
  model: unknown
  models?: unknown
}): void {
  assertAllowedModel(payload.model)

  if (!Object.hasOwn(payload, "models")) return
  if (!Array.isArray(payload.models)) throw new ModelNotAllowedError()

  for (const model of payload.models) {
    assertAllowedModel(model)
  }
}

export function filterAllowedModels<T>(
  models: Array<T>,
  getModelId: (model: T) => unknown,
): Array<T> {
  return models.filter((model) => isAllowedModel(getModelId(model)))
}

export function modelNotAllowedResponse(c: Context): Response {
  return c.json({ error: MODEL_NOT_ALLOWED_ERROR }, 400)
}
