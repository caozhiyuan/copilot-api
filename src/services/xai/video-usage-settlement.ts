import consola from "consola"

import { resolveProviderConfig } from "~/lib/providers/provider-resolver"
import {
  deferVideoUsageJob,
  getDueVideoUsageJobs,
} from "~/lib/video-settlement"
import { recordVideoResultUsage } from "~/lib/token-usage/videos"

import { forwardXaiVideos } from "./videos"

const VIDEO_USAGE_BATCH_SIZE = 4
const VIDEO_USAGE_RETRY_DELAY_MS = 30_000
const VIDEO_USAGE_REQUEST_TIMEOUT_MS = 10_000

export const videoUsageSettlementDependencies = { resolveProviderConfig }

export async function settlePendingVideoUsage(
  signal: AbortSignal,
  now = Date.now(),
): Promise<void> {
  const jobs = await getDueVideoUsageJobs("xai", now, VIDEO_USAGE_BATCH_SIZE)
  if (!jobs.length || signal.aborted) return
  const providerConfig =
    await videoUsageSettlementDependencies.resolveProviderConfig("xai")
  if (!providerConfig || signal.aborted) return

  await Promise.all(
    jobs.map(async (job) => {
      try {
        if (!(await deferVideoUsageJob(job, now + VIDEO_USAGE_RETRY_DELAY_MS)))
          return
        const pollSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(VIDEO_USAGE_REQUEST_TIMEOUT_MS),
        ])
        const request = new Request("http://localhost/", {
          signal: pollSignal,
        })
        const response = await forwardXaiVideos(providerConfig, request, {
          operation: "result",
          requestId: job.request_id,
          signal: pollSignal,
        })
        try {
          await recordVideoResultUsage(response, {
            providerConfig,
            requestId: job.request_id,
            defaultModel: job.model,
            job,
          })
        } finally {
          await response.body?.cancel().catch(() => {})
        }
      } catch (error) {
        if (!signal.aborted) consola.warn("Failed to check video usage", error)
      }
    }),
  )
}
