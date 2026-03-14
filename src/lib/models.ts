import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"

export const findEndpointModel = (sdkModelId: string): Model | undefined => {
  const models = state.models?.data ?? []
  const exactMatch = models.find((m) => m.id === sdkModelId)
  if (exactMatch) {
    return exactMatch
  }

  const normalized = _normalizeSdkModelId(sdkModelId)
  if (!normalized) {
    return undefined
  }

  const modelName = `claude-${normalized.family}-${normalized.version}`
  const model = models.find((m) => m.id === modelName)
  if (model) {
    return model
  }

  return undefined
}

/**
 * Normalizes an SDK model ID to extract the model family and version.
 * this method from github copilot extension
 * Examples:
 * - "claude-opus-4-5-20251101" -> { family: "opus", version: "4.5" }
 * - "claude-3-5-sonnet-20241022" -> { family: "sonnet", version: "3.5" }
 * - "claude-sonnet-4-20250514" -> { family: "sonnet", version: "4" }
 * - "claude-haiku-3-5-20250514" -> { family: "haiku", version: "3.5" }
 * - "claude-haiku-4.5" -> { family: "haiku", version: "4.5" }
 */
const _normalizeSdkModelId = (
  sdkModelId: string,
): { family: string; version: string } | undefined => {
  const lower = sdkModelId.toLowerCase()

  // Strip date suffix (8 digits at the end)
  const withoutDate = lower.replace(/-\d{8}$/, "")

  // Pattern 1: claude-{family}-{major}-{minor} (e.g., claude-opus-4-5, claude-haiku-3-5)
  const pattern1 = withoutDate.match(/^claude-(\w+)-(\d+)-(\d+)$/)
  if (pattern1) {
    return { family: pattern1[1], version: `${pattern1[2]}.${pattern1[3]}` }
  }

  // Pattern 2: claude-{major}-{minor}-{family} (e.g., claude-3-5-sonnet)
  const pattern2 = withoutDate.match(/^claude-(\d+)-(\d+)-(\w+)$/)
  if (pattern2) {
    return { family: pattern2[3], version: `${pattern2[1]}.${pattern2[2]}` }
  }

  // Pattern 3: claude-{family}-{major}.{minor} (e.g., claude-haiku-4.5)
  const pattern3 = withoutDate.match(/^claude-(\w+)-(\d+)\.(\d+)$/)
  if (pattern3) {
    return { family: pattern3[1], version: `${pattern3[2]}.${pattern3[3]}` }
  }

  // Pattern 4: claude-{family}-{major} (e.g., claude-sonnet-4)
  const pattern4 = withoutDate.match(/^claude-(\w+)-(\d+)$/)
  if (pattern4) {
    return { family: pattern4[1], version: pattern4[2] }
  }

  // Pattern 5: claude-{major}-{family} (e.g., claude-3-opus)
  const pattern5 = withoutDate.match(/^claude-(\d+)-(\w+)$/)
  if (pattern5) {
    return { family: pattern5[2], version: pattern5[1] }
  }

  return undefined
}
