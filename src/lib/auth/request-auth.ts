import type { Context, MiddlewareHandler } from "hono"

import { getConfig } from "../config"
import {
  isApiKeyActive,
  normalizeApiKeyRecords,
  normalizeApiKeys,
} from "../config/api-key-config"
import { requestContext } from "../http/request-context"

export { normalizeApiKeys }

interface AuthMiddlewareOptions {
  getApiKeys?: () => Array<string>
  allowUnauthenticatedPaths?: Array<string>
  allowOptionsBypass?: boolean
  allowWhenNoApiKeys?: boolean
  shouldSkipPath?: (path: string) => boolean
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

export function getIsolatedApiKeyId(): string | undefined {
  const id = requestContext.getStore()?.apiKey?.id
  return id !== undefined && getConfig().auth?.isolateApiKeyUsage === true ?
      id
    : undefined
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
  // The configured-key reader uses managed policies even when passed explicitly.
  const getApiKeys =
    options.getApiKeys === getConfiguredApiKeys ? undefined : options.getApiKeys
  const allowUnauthenticatedPaths = options.allowUnauthenticatedPaths ?? ["/"]
  const allowOptionsBypass = options.allowOptionsBypass ?? true
  const allowWhenNoApiKeys = options.allowWhenNoApiKeys ?? true
  const shouldSkipPath = options.shouldSkipPath ?? (() => false)

  return async (c, next) => {
    if (
      (allowOptionsBypass && c.req.method === "OPTIONS")
      || shouldSkipPath(c.req.path)
      || allowUnauthenticatedPaths.includes(c.req.path)
    ) {
      return next()
    }

    const auth = getApiKeys ? undefined : getConfig().auth
    const apiKeys =
      getApiKeys ? getApiKeys() : normalizeApiKeyRecords(auth?.apiKeyConfigs)
    if (apiKeys.length === 0) {
      return allowWhenNoApiKeys ? next() : createUnauthorizedResponse(c)
    }

    const requestApiKey = extractRequestApiKey(c)
    if (!requestApiKey) return createUnauthorizedResponse(c)

    const key = apiKeys.find((entry) => {
      if (typeof entry === "string") return entry === requestApiKey
      return !getApiKeys && entry.key === requestApiKey
    })
    if (key === undefined) return createUnauthorizedResponse(c)
    if (typeof key === "string") return next()
    if (!isApiKeyActive(key)) return createUnauthorizedResponse(c)

    const context = requestContext.getStore()
    if (context) context.apiKey = key
    c.header(
      "X-API-Key-Usage-Isolated",
      String(auth?.isolateApiKeyUsage === true),
    )
    return next()
  }
}
