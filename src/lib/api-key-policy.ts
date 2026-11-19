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
import { getIsolatedApiKeyId } from "./request-auth"
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

async function filterModelCatalog(
  c: Context,
  key: GatewayApiKeyConfig,
): Promise<void> {
  const response = c.res
  const payload: unknown = await response
    .clone()
    .json()
    .catch(() => null)
  if (typeof payload !== "object" || payload === null) return

  const catalog:
    | { field: "data" | "models"; entries: Array<unknown> }
    | undefined =
    "data" in payload && Array.isArray(payload.data) ?
      { field: "data", entries: payload.data }
    : "models" in payload && Array.isArray(payload.models) ?
      { field: "models", entries: payload.models }
    : undefined
  if (!catalog) return

  const { field, entries } = catalog
  const pathProvider = c.req.path
    .replace(/^\/|\/$/g, "")
    .split("/")
    .find((part) => part !== "v1" && part !== "models")
  const isClaude = isClaudeUserAgent(c.req.header("user-agent"))
  const models = entries.filter((model) => {
    if (typeof model !== "object" || model === null) return false
    const id =
      "slug" in model && typeof model.slug === "string" ? model.slug
      : "id" in model ? model.id
      : undefined
    if (typeof id !== "string") return false
    const upstreamId = isClaude ? fromClaudeDiscoveryModelId(id) : id
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
  const headers = new Headers(response.headers)
  for (const name of ["content-length", "etag", "content-encoding"]) {
    headers.delete(name)
    c.header(name, undefined)
  }
  c.res = Response.json(
    { ...payload, [field]: models },
    { status: response.status, headers },
  )
}

export const apiKeyPolicyMiddleware: MiddlewareHandler = async (c, next) => {
  const key = requestContext.getStore()?.apiKey
  if (
    /^\/usage(?:\/|$)/.test(c.req.path)
    && getIsolatedApiKeyId() !== undefined
  ) {
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
    key?.allowedModels
    && c.req.method === "GET"
    && /(?:^|\/)models\/?$/.test(c.req.path)
    && c.res.ok
  ) {
    await filterModelCatalog(c, key)
  }
}
