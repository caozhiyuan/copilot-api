import type { GatewayApiKeyConfig } from "./api-key-config"
import { isApiKeyModelAllowed } from "./api-key-config"
import { HTTPError } from "./error"
import {
  getRawProviderConfig,
  type ResolvedProviderConfig,
} from "./provider-config"
import { getTokenUsagePricingCurrency } from "./token-usage/pricing"
import { resolveUsdRate } from "./token-usage/currency"
import type { TokenUsageEndpoint } from "./token-usage/store"
import { AsyncLocalStorage } from "node:async_hooks"
import type { RequestEventObserver } from "./types/gateway-plugins"
import type { SubagentMarker } from "./subagent"

export interface RequestTiming {
  id: string
  firstTokenMs: number | null
  durationMs: number | null
  outcome: "completed" | "cancelled" | "error" | null
  protocolFailed?: boolean
  hasUsage: boolean
  recordFirstToken: () => void
}

export interface RequestContext {
  apiKey?: GatewayApiKeyConfig
  apiKeyUsageIds?: Set<string>
  traceId: string
  startTime: number
  userAgent: string
  sessionAffinity: string | undefined
  rootSessionId?: string
  isClaudeCode?: boolean
  parentSessionId: string | undefined
  subagent?: SubagentMarker | null
  pluginRequest?: RequestEventObserver
  requestTiming?: RequestTiming
}

const TRACE_ID_MAX_LENGTH = 64
const TRACE_ID_PATTERN = /^\w[\w.-]*$/

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>()

export const requestContext = {
  getStore: () => asyncLocalStorage.getStore(),
  run: <T>(context: RequestContext, callback: () => T) =>
    asyncLocalStorage.run(context, callback),
}

// Observe the final target at upstream dispatch, after mapping and overrides.
export function formatPluginActualModel(
  model: string,
  provider?: string | null,
): string {
  return !model || !provider || provider === "github-copilot" ?
      model
    : `${provider}/${model}`
}

export function setPluginRequestActualModel(
  model: string,
  provider?: string | ResolvedProviderConfig,
  endpoint?: TokenUsageEndpoint,
): void {
  const key = requestContext.getStore()?.apiKey
  const name =
    (typeof provider === "string" ? provider : provider?.name)
    ?? "github-copilot"
  if (key && !isApiKeyModelAllowed(key, model, name)) {
    throw new HTTPError(
      "Model is not allowed for this API key",
      Response.json(
        {
          error: {
            message: "Model is not allowed for this API key",
            type: "permission_error",
            code: "model_not_allowed",
          },
        },
        { status: 403 },
      ),
    )
  }
  if (key?.quota) {
    const config =
      typeof provider === "object" ? provider : getRawProviderConfig(name)
    const currency = getTokenUsagePricingCurrency({
      model,
      endpoint,
      providerName: name,
      source: name === "github-copilot" ? "copilot" : "provider",
      pricing: config?.models?.[model]?.pricing,
      pricingCurrency: config?.pricingCurrency,
      baseUrl: config?.baseUrl,
    })
    if (resolveUsdRate(currency) === undefined)
      throw new HTTPError(
        "Model pricing unavailable for this spending limit",
        Response.json(
          {
            error: {
              message:
                currency ?
                  `Model currency ${currency} cannot be converted to USD`
                : "Model has no supported pricing or reported-cost source",
              type: "permission_error",
              code: "model_pricing_unavailable",
            },
          },
          { status: 403 },
        ),
      )
  }
  requestContext
    .getStore()
    ?.pluginRequest?.setActualModel(formatPluginActualModel(model, name))
}

export function generateTraceId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `${timestamp}-${random}`
}

export function resolveTraceId(traceId: string | null | undefined): string {
  const candidate = traceId?.trim()

  if (
    !candidate
    || candidate.length > TRACE_ID_MAX_LENGTH
    || !TRACE_ID_PATTERN.test(candidate)
  ) {
    return generateTraceId()
  }

  return candidate
}
