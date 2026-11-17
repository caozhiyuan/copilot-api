import type { ResolvedProviderConfig } from "~/lib/config"
import { requestContext } from "~/lib/request-context"

import { recordTokenUsageEvent, resolveTokenUsageSessionId } from "./index"
import { xaiUsdTicksToCost } from "./pricing"
import {
  saveVideoUsageJob,
  stopPollingVideoUsageJob,
  type VideoUsageJob,
} from "./store"

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
    job?: VideoUsageJob
    onBody?: (body: string) => void
  },
): Promise<void> {
  let body: string
  try {
    body = await response.clone().text()
  } catch {
    // Preserve upstream body errors instead of replacing the proxy response.
    return
  }
  if (options.operation !== "generations") options.onBody?.(body)
  if (!response.ok) return

  let result: unknown
  try {
    result = JSON.parse(body) as unknown
  } catch {
    return
  }
  if (!isRecord(result)) return
  if (options.operation === "generations") {
    const context = requestContext.getStore()
    if (
      typeof result.request_id === "string"
      && result.request_id.trim()
      && context?.apiKey
    ) {
      await saveVideoUsageJob({
        provider_name: options.providerConfig.name,
        request_id: result.request_id,
        api_key_id: context.apiKey.id,
        api_key_name: context.apiKey.name ?? null,
        model: options.defaultModel,
        trace_id: context.traceId,
        session_id: resolveTokenUsageSessionId(undefined),
      })
    }
    return
  }
  const job = options.job
  if (job?.settled) return
  if (job && (result.status === "failed" || result.status === "expired")) {
    await stopPollingVideoUsageJob(job)
    return
  }
  if (result.status !== "done" || !isRecord(result.usage)) return
  const cost = xaiUsdTicksToCost(result.usage.cost_in_usd_ticks)
  if (cost === undefined) return

  recordTokenUsageEvent({
    apiKey:
      job ?
        { id: job.api_key_id, name: job.api_key_name ?? undefined }
      : undefined,
    source: "provider",
    providerName: options.providerConfig.name,
    endpoint: "videos_generations",
    model:
      typeof result.model === "string" && result.model.trim() ?
        result.model
      : options.defaultModel,
    cost,
    upstreamRequestId: options.requestId,
    traceId: job?.trace_id,
    sessionId: job?.session_id,
  })
}
