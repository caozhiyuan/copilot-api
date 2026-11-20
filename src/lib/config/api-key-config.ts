import consola from "consola"
import { createHash } from "node:crypto"

import { isValidCostAmount } from "../token-usage/currency"
import type { GatewayApiKeyConfig } from "../types/api-key"
export type { GatewayApiKeyConfig, ApiKeyQuotaPeriod } from "../types/api-key"

export function normalizeApiKeys(apiKeys: unknown): Array<string> {
  if (!Array.isArray(apiKeys)) {
    if (apiKeys !== undefined) {
      consola.warn("Invalid auth.apiKeys config. Expected an array of strings.")
    }
    return []
  }

  const normalizedKeys = apiKeys
    .filter((key): key is string => typeof key === "string")
    .map((key) => key.trim())
    .filter((key) => key.length > 0)

  if (normalizedKeys.length !== apiKeys.length) {
    consola.warn(
      "Invalid auth.apiKeys entries found. Only non-empty strings are allowed.",
    )
  }

  return [...new Set(normalizedKeys)]
}

export function legacyApiKeyId(key: string): string {
  return (
    "key_"
    + createHash("sha256")
      .update("copilot-api:key:v1\0" + key)
      .digest("hex")
      .slice(0, 32)
  )
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "Each API key must be a non-empty string or a key configuration",
    )
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(field + " must be a non-empty string")
  }
  return value.trim()
}

export function normalizeApiKeyRecord(value: unknown): GatewayApiKeyConfig {
  if (typeof value === "string") {
    const key = nonEmptyString(value, "API key")
    return { id: legacyApiKeyId(key), key }
  }
  const input = record(value)
  const key = nonEmptyString(input.key, "API key")
  const id =
    input.id === undefined ?
      legacyApiKeyId(key)
    : nonEmptyString(input.id, "API key id")
  if (!/^[\w-]{1,128}$/.test(id))
    throw new Error(
      "API key id must contain only letters, digits, underscores, or hyphens",
    )
  const result: GatewayApiKeyConfig = { id, key }
  if (input.name !== undefined)
    result.name = nonEmptyString(input.name, "API key name")
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean")
      throw new Error("API key enabled must be a boolean")
    result.enabled = input.enabled
  }
  if (input.expiresAt !== undefined) {
    const expiresAt = nonEmptyString(input.expiresAt, "API key expiry")
    if (!Number.isFinite(Date.parse(expiresAt)))
      throw new Error("API key expiry must be a valid date")
    result.expiresAt = new Date(expiresAt).toISOString()
  }
  if (input.allowedModels !== undefined) {
    if (!Array.isArray(input.allowedModels))
      throw new Error("API key allowedModels must be an array")
    result.allowedModels = [
      ...new Set(
        input.allowedModels.map((model: unknown) =>
          nonEmptyString(model, "Allowed model"),
        ),
      ),
    ]
  }
  if (input.quota !== undefined) {
    const quota = record(input.quota)
    if (
      quota.period !== "day"
      && quota.period !== "month"
      && quota.period !== "lifetime"
    ) {
      throw new Error("API key quota period must be day, month, or lifetime")
    }
    if (!isValidCostAmount(quota.amount)) {
      throw new Error(
        "API key amount must be non-negative and fit in cost nanos",
      )
    }
    result.quota = { period: quota.period, amount: quota.amount }
  }
  return result
}

export function normalizeApiKeyRecords(
  value: unknown,
): Array<GatewayApiKeyConfig> {
  if (value === undefined) return []
  if (!Array.isArray(value))
    throw new Error("auth.apiKeyConfigs must be an array")
  const result: Array<GatewayApiKeyConfig> = []
  const keys = new Set<string>()
  const ids = new Set<string>()
  for (const entry of value) {
    if (typeof entry === "string" && !entry.trim()) continue
    const normalized = normalizeApiKeyRecord(entry)
    if (keys.has(normalized.key)) continue
    if (ids.has(normalized.id)) throw new Error("API key ids must be unique")
    keys.add(normalized.key)
    ids.add(normalized.id)
    result.push(normalized)
  }
  return result
}

export function isApiKeyActive(
  key: GatewayApiKeyConfig,
  now = Date.now(),
): boolean {
  return (
    key.enabled !== false
    && (key.expiresAt === undefined || Date.parse(key.expiresAt) > now)
  )
}

export function isApiKeyModelAllowed(
  key: GatewayApiKeyConfig,
  model: string,
  provider = "github-copilot",
): boolean {
  if (key.allowedModels === undefined) return true
  const target = provider + "/" + model
  return key.allowedModels.some((pattern) => {
    const expression =
      "^"
      + pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&"))
        .join(".*")
      + "$"
    const match = new RegExp(expression)
    return match.test(target) || (!pattern.includes("/") && match.test(model))
  })
}
