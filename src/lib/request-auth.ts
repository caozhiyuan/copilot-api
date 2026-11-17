import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

import { getConfig } from "./config"
import { normalizeApiKeyRecords, isApiKeyActive } from "./api-key-config"
import { requestContext } from "./request-context"

interface AuthMiddlewareOptions {
  getApiKeys?: () => Array<string>
  allowUnauthenticatedPaths?: Array<string>
  allowOptionsBypass?: boolean
  allowWhenNoApiKeys?: boolean
  shouldSkipPath?: (path: string) => boolean
}

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

export function getConfiguredApiKeys(): Array<string> {
  const config = getConfig()
  return normalizeApiKeyRecords(config.auth?.apiKeyConfigs).map(
    (entry) => entry.key,
  )
}

export function getMissingApiKeysMessage(): string | null {
  const apiKeys = getConfiguredApiKeys()
  if (apiKeys.length > 0) {
    return null
  }

  return [
    "Requests currently bypass authentication.",
    "Run `npx @jeffreycao/copilot-api@latest auth keys --add <key>` to enable API key auth.",
  ].join(" ")
}

function normalizeApiKey(apiKey: unknown): string | null {
  if (typeof apiKey !== "string") {
    return null
  }

  const normalizedApiKey = apiKey.trim()
  return normalizedApiKey || null
}

export function getConfiguredAdminApiKeys(): Array<string> {
  const config = getConfig()
  const adminApiKey = normalizeApiKey(config.auth?.adminApiKey)
  return adminApiKey ? [adminApiKey] : []
}

export function isApiKeyUsageIsolated(): boolean {
  return (
    !!requestContext.getStore()?.apiKey
    && getConfig().auth?.isolateApiKeyUsage === true
  )
}

export function extractRequestApiKey(c: Context): string | null {
  const xApiKey = c.req.header("x-api-key")?.trim()
  if (xApiKey) {
    return xApiKey
  }

  const authorization = c.req.header("authorization")
  if (!authorization) {
    return null
  }

  const [scheme, ...rest] = authorization.trim().split(/\s+/)
  if (scheme.toLowerCase() !== "bearer") {
    return null
  }

  const bearerToken = rest.join(" ").trim()
  return bearerToken || null
}

function createUnauthorizedResponse(c: Context): Response {
  c.header("WWW-Authenticate", 'Bearer realm="copilot-api"')
  return c.json(
    {
      error: {
        message: "Unauthorized",
        type: "authentication_error",
      },
    },
    401,
  )
}

export function createAuthMiddleware(
  options: AuthMiddlewareOptions = {},
): MiddlewareHandler {
  const getApiKeys = options.getApiKeys ?? getConfiguredApiKeys
  const allowUnauthenticatedPaths = options.allowUnauthenticatedPaths ?? ["/"]
  const allowOptionsBypass = options.allowOptionsBypass ?? true
  const allowWhenNoApiKeys = options.allowWhenNoApiKeys ?? true
  const shouldSkipPath = options.shouldSkipPath ?? (() => false)

  return async (c, next) => {
    if (allowOptionsBypass && c.req.method === "OPTIONS") {
      return next()
    }

    if (shouldSkipPath(c.req.path)) {
      return next()
    }

    if (allowUnauthenticatedPaths.includes(c.req.path)) {
      return next()
    }

    const apiKeys = getApiKeys()
    if (apiKeys.length === 0) {
      return allowWhenNoApiKeys ? next() : createUnauthorizedResponse(c)
    }

    const requestApiKey = extractRequestApiKey(c)
    if (!requestApiKey || !apiKeys.includes(requestApiKey)) {
      return createUnauthorizedResponse(c)
    }

    if (getApiKeys === getConfiguredApiKeys) {
      const key = normalizeApiKeyRecords(getConfig().auth?.apiKeyConfigs).find(
        (entry) => entry.key === requestApiKey,
      )
      if (!key || !isApiKeyActive(key)) return createUnauthorizedResponse(c)
      const context = requestContext.getStore()
      if (context) context.apiKey = key
      c.header(
        "X-API-Key-Usage-Isolated",
        String(getConfig().auth?.isolateApiKeyUsage === true),
      )
    }
    return next()
  }
}
