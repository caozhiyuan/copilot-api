import { isApiKeyModelAllowed } from "../config/api-key-config"
import { HTTPError } from "./http-error"
import { getRawProviderConfig } from "../config/provider-config"
import { requestContext } from "./request-context-store"
import { getTokenUsagePricingCurrency } from "../token-usage/pricing"
import { resolveUsdRate } from "../token-usage/currency"
import type { ResolvedProviderConfig } from "../types/config"
import type { TokenUsageEndpoint } from "../types/token-usage"

export { requestContext, type RequestContext } from "./request-context-store"
export type { RequestTiming } from "../types/token-usage"

const TRACE_ID_MAX_LENGTH = 64
const TRACE_ID_PATTERN = /^\w[\w.-]*$/

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
