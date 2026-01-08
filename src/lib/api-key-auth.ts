import type { MiddlewareHandler } from "hono"

import { getConfig } from "./config"

const API_KEY_ENV_VAR = "COPILOT_API_KEY"

export type ApiKeyAuthOptions = {
  /**
   * Injected for tests; defaults to env+config resolution.
   */
  getConfiguredApiKey?: () => string | undefined

  /**
   * Injected for tests; defaults to the built-in protected path matcher.
   */
  isProtectedPath?: (pathname: string) => boolean
}

export function resolveConfiguredApiKey(): string | undefined {
  const envKey = process.env[API_KEY_ENV_VAR]?.trim()
  if (envKey) return envKey

  const configKey = getConfig().apiKey?.trim()
  if (configKey) return configKey

  return undefined
}

export function parseBearerToken(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed.toLowerCase().startsWith("bearer ")) return undefined

  const token = trimmed.slice("bearer ".length).trim()
  return token || undefined
}

export function extractRequestApiKey(headers: Headers): string | undefined {
  const headerToken = headers.get("x-api-key")?.trim()
  if (headerToken) return headerToken

  const bearer = headers.get("authorization")
  if (bearer) {
    const token = parseBearerToken(bearer)
    if (token) return token
  }

  return undefined
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

export function isProtectedPath(pathnameRaw: string): boolean {
  const pathname = normalizePathname(pathnameRaw)

  return (
    hasPrefixBoundary(pathname, "/v1")
    || hasPrefixBoundary(pathname, "/token")
    || hasPrefixBoundary(pathname, "/usage")
    || hasPrefixBoundary(pathname, "/chat/completions")
    || hasPrefixBoundary(pathname, "/embeddings")
    || hasPrefixBoundary(pathname, "/models")
    || hasPrefixBoundary(pathname, "/responses")
  )
}

export function createApiKeyAuthMiddleware(
  options: ApiKeyAuthOptions = {},
): MiddlewareHandler {
  const getConfiguredKey =
    options.getConfiguredApiKey ?? resolveConfiguredApiKey
  const isPathProtected = options.isProtectedPath ?? isProtectedPath

  return async (c, next) => {
    if (c.req.method === "OPTIONS") {
      await next()
      return
    }

    const url = new URL(c.req.url, "http://local")
    if (!isPathProtected(url.pathname)) {
      await next()
      return
    }

    // User requirement: when key is not configured at all, allow all traffic.
    const configuredKey = getConfiguredKey()
    if (!configuredKey) {
      await next()
      return
    }

    const providedKey = extractRequestApiKey(c.req.raw.headers)

    if (!providedKey || providedKey !== configuredKey) {
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

    await next()
  }
}
