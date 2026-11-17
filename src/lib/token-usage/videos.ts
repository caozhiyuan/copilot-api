import type { ResolvedProviderConfig } from "~/lib/config"
import { requestContext } from "~/lib/request-context"

import { recordTokenUsageEvent } from "./index"
import { xaiUsdTicksToCost } from "./pricing"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Reads the finite result JSON once for usage accounting and debug output. */
export async function recordVideoResultUsage(
  response: Response,
  options: {
    providerConfig: ResolvedProviderConfig
    requestId: string
    defaultModel: string
    operation?: "generations" | "result"
    onBody: (body: string) => void
  },
): Promise<void> {
  let body: string
  try {
    body = await response.clone().text()
  } catch {
    // Preserve upstream body errors instead of replacing the proxy response.
    return
  }
  if (options.operation !== "generations") options.onBody(body)
  if (!response.ok) return

  let result: unknown
  try {
    result = JSON.parse(body) as unknown
  } catch {
    return
  }
  if (options.operation === "generations") {
    if (
      isRecord(result)
      && typeof result.request_id === "string"
      && result.request_id
      && requestContext.getStore()?.apiKey
    ) {
      recordTokenUsageEvent({
        source: "provider",
        providerName: options.providerConfig.name,
        endpoint: "videos_generations",
        model: options.defaultModel,
        cost: 0,
        upstreamRequestId: "pending:" + result.request_id,
      })
    }
    return
  }
  if (
    !isRecord(result)
    || result.status !== "done"
    || !isRecord(result.usage)
  ) {
    return
  }
  const cost = xaiUsdTicksToCost(result.usage.cost_in_usd_ticks)
  if (cost === undefined) return

  recordTokenUsageEvent({
    source: "provider",
    providerName: options.providerConfig.name,
    endpoint: "videos_generations",
    model:
      typeof result.model === "string" && result.model.trim() ?
        result.model
      : options.defaultModel,
    cost,
    upstreamRequestId: options.requestId,
  })
}
