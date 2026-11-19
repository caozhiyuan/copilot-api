import type { Context, MiddlewareHandler } from "hono"

import { forwardError } from "./error"
import { requestContext } from "./request-context"
import { getIsolatedApiKeyId } from "./request-auth"
import { getApiKeyQuotaAdmission } from "./token-usage/store"
import type { GatewayApiKeyConfig } from "./types/api-key"

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
}
