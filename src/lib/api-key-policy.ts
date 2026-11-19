import { fromClaudeDiscoveryModelId, isClaudeUserAgent } from "./claude-models"
import type { Context, MiddlewareHandler } from "hono"

import { getRawProviderConfig } from "./provider-config"
import { resolveMappedModel } from "./model-policy"
import {
  isApiKeyModelAllowed,
  type GatewayApiKeyConfig,
} from "./api-key-config"
import { forwardError } from "./error"
import { requestContext } from "./request-context"
import { isApiKeyUsageIsolated } from "./request-auth"
import { getApiKeyQuotaAdmission } from "./token-usage/store"

export const apiKeyPolicyDependencies = {
  getRawProviderConfig,
  resolveMappedModel,
}

async function checkApiKeyQuota(
  c: Context,
  key: GatewayApiKeyConfig,
): Promise<Response | undefined> {
  try {
    const { remainingCostNanos, endMs } = await getApiKeyQuotaAdmission(key)
    if (remainingCostNanos !== 0) return undefined

    if (endMs) {
      const retryAfter = Math.max(1, Math.ceil((endMs - Date.now()) / 1000))
      c.header("Retry-After", String(retryAfter))
    }
    return c.json(
      {
        error: {
          message: "API key spending limit exhausted",
          type: "rate_limit_error",
          code: "api_key_quota_exceeded",
        },
      },
      429,
    )
  } catch (error) {
    return c.json(
      {
        error: {
          message:
            error instanceof Error ?
              error.message
            : "API key quota unavailable",
          type: "service_unavailable",
        },
      },
      503,
    )
  }
}

export const apiKeyPolicyMiddleware: MiddlewareHandler = async (c, next) => {
  const key = requestContext.getStore()?.apiKey
  if (isApiKeyUsageIsolated() && /^\/usage(?:\/|$)/.test(c.req.path)) {
    return c.json(
      {
        error: {
          message: "Subscription usage is unavailable for isolated API keys",
          type: "permission_error",
        },
      },
      403,
    )
  }
  if (key?.quota && c.req.method === "POST") {
    const rejection = await checkApiKeyQuota(c, key)
    if (rejection) return rejection
  }
  try {
    await next()
  } catch (error) {
    return await forwardError(c, error)
  }
  if (
    !key?.allowedModels
    || c.req.method !== "GET"
    || !/(?:^|\/)models\/?$/.test(c.req.path)
    || !c.res.ok
  )
    return
  const body: unknown = await c.res
    .clone()
    .json()
    .catch(() => null)
  if (typeof body !== "object" || body === null) return
  const payload = body as Record<string, unknown>
  const list =
    Array.isArray(payload.data) ? "data"
    : Array.isArray(payload.models) ? "models"
    : null
  if (!list) return
  const pathProvider = c.req.path
    .replace(/^\/|\/$/g, "")
    .split("/")
    .find((part) => part !== "v1" && part !== "models")
  const data = (payload[list] as Array<unknown>).filter((value) => {
    if (typeof value !== "object" || value === null) return false
    const model = value as Record<string, unknown>
    const id = typeof model.slug === "string" ? model.slug : model.id
    if (typeof id !== "string") return false
    const upstreamId =
      isClaudeUserAgent(c.req.header("user-agent")) ?
        fromClaudeDiscoveryModelId(id)
      : id
    const target =
      pathProvider ? upstreamId : (
        apiKeyPolicyDependencies.resolveMappedModel(upstreamId)
      )
    const slash = target.indexOf("/")
    const provider =
      pathProvider
      ?? ((
        slash > 0
        && apiKeyPolicyDependencies.getRawProviderConfig(target.slice(0, slash))
      ) ?
        target.slice(0, slash)
      : "github-copilot")
    const actual =
      target.startsWith(provider + "/") ?
        target.slice(provider.length + 1)
      : target
    return isApiKeyModelAllowed(key, actual, provider)
  })
  const headers = new Headers(c.res.headers)
  for (const name of ["content-length", "etag", "content-encoding"]) {
    headers.delete(name)
    c.header(name, undefined)
  }
  c.res = Response.json(
    { ...payload, [list]: data },
    { status: c.res.status, headers },
  )
}
