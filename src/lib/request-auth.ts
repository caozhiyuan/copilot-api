import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"
import { timingSafeEqual } from "node:crypto"

import { getConfig } from "./config"

const LEGACY_API_KEY_ENV_VAR = "COPILOT_API_KEY"

let warnedLegacyEnvFallback = false
let warnedLegacyConfigFallback = false

interface AuthMiddlewareOptions {
  getApiKeys?: () => Array<string>
  allowUnauthenticatedPaths?: Array<string>
  allowUnauthenticatedPathPrefixes?: Array<string>
  allowOptionsBypass?: boolean
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
  const configuredApiKeys = normalizeApiKeys(config.auth?.apiKeys)
  if (configuredApiKeys.length > 0) {
    return configuredApiKeys
  }

  const envApiKey = process.env[LEGACY_API_KEY_ENV_VAR]?.trim()
  if (envApiKey) {
    if (!warnedLegacyEnvFallback) {
      warnedLegacyEnvFallback = true
      consola.warn(
        `Using legacy ${LEGACY_API_KEY_ENV_VAR}. Please migrate to config.auth.apiKeys.`,
      )
    }
    return [envApiKey]
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const legacyConfigApiKey = config.apiKey?.trim()
  if (legacyConfigApiKey) {
    if (!warnedLegacyConfigFallback) {
      warnedLegacyConfigFallback = true
      consola.warn(
        "Using deprecated config.apiKey. Please migrate to config.auth.apiKeys.",
      )
    }
    return [legacyConfigApiKey]
  }

  return configuredApiKeys
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
        message:
          "Unauthorized. Provide Authorization: Bearer <key> or x-api-key.",
        type: "unauthorized",
      },
    },
    401,
  )
}

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1)
  }
  return pathname
}

function hasPrefixBoundary(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

function timingSafeKeyCompare(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a)
    const bBuf = Buffer.from(b)
    if (aBuf.length !== bBuf.length) return false
    return timingSafeEqual(aBuf, bBuf)
  } catch {
    return false
  }
}

export function createAuthMiddleware(
  options: AuthMiddlewareOptions = {},
): MiddlewareHandler {
  const getApiKeys = options.getApiKeys ?? getConfiguredApiKeys
  const allowUnauthenticatedPaths = new Set(
    (options.allowUnauthenticatedPaths ?? ["/"]).map((path) =>
      normalizePathname(path),
    ),
  )
  const allowUnauthenticatedPathPrefixes = (
    options.allowUnauthenticatedPathPrefixes ?? []
  ).map((path) => normalizePathname(path))
  const allowOptionsBypass = options.allowOptionsBypass ?? true

  return async (c, next) => {
    if (allowOptionsBypass && c.req.method === "OPTIONS") {
      return next()
    }

    const pathname = normalizePathname(
      new URL(c.req.url, "http://local").pathname,
    )

    if (allowUnauthenticatedPaths.has(pathname)) {
      return next()
    }

    if (
      allowUnauthenticatedPathPrefixes.some((prefix) =>
        hasPrefixBoundary(pathname, prefix),
      )
    ) {
      return next()
    }

    const apiKeys = getApiKeys()
    if (apiKeys.length === 0) {
      return next()
    }

    const requestApiKey = extractRequestApiKey(c)
    const hasValidApiKey =
      requestApiKey ?
        apiKeys.some((apiKey) => timingSafeKeyCompare(requestApiKey, apiKey))
      : false
    if (!hasValidApiKey) {
      return createUnauthorizedResponse(c)
    }

    return next()
  }
}
