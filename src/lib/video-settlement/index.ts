import consola from "consola"

import {
  getUsageWorker,
  isTokenUsageStorageEnabled,
  registerUsageStoreShutdownHook,
} from "~/lib/token-usage/runtime"
import type { VideoUsageJob } from "~/lib/types/token-usage"

import { VIDEO_USAGE_POLL_INTERVAL_MS } from "./db"

let stopVideoUsageSettlement: (() => Promise<void>) | undefined

registerUsageStoreShutdownHook(async () => {
  await stopVideoUsageSettlement?.()
  stopVideoUsageSettlement = undefined
})

export async function getVideoUsageJob(provider: string, requestId: string) {
  if (!isTokenUsageStorageEnabled()) return undefined
  return getUsageWorker().execute("getVideoUsageJob", provider, requestId)
}

export async function saveVideoUsageJob(
  job: Omit<VideoUsageJob, "settled" | "next_poll_at_ms">,
): Promise<void> {
  if (!isTokenUsageStorageEnabled()) return
  await getUsageWorker().execute("saveVideoUsageJob", job)
}

export async function getDueVideoUsageJobs(
  provider: string,
  now: number,
  limit: number,
) {
  return getUsageWorker().execute("getDueVideoUsageJobs", provider, now, limit)
}

export async function deferVideoUsageJob(
  job: VideoUsageJob,
  nextPollAtMs: number,
) {
  return getUsageWorker().execute("deferVideoUsageJob", job, nextPollAtMs)
}

export async function stopPollingVideoUsageJob(
  job: VideoUsageJob,
): Promise<void> {
  await getUsageWorker().execute("stopPollingVideoUsageJob", job)
}

export function startVideoUsageSettlement(
  poll: (signal: AbortSignal) => Promise<void>,
): void {
  if (stopVideoUsageSettlement || !isTokenUsageStorageEnabled()) return
  const controller = new AbortController()
  let activePoll: Promise<void> | undefined
  const pollIfIdle = () => {
    if (activePoll) return
    activePoll = poll(controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          consola.warn("Failed to check pending video usage", error)
      })
      .finally(() => {
        activePoll = undefined
      })
  }
  const timer = setInterval(pollIfIdle, VIDEO_USAGE_POLL_INTERVAL_MS)
  timer.unref?.()
  stopVideoUsageSettlement = async () => {
    clearInterval(timer)
    controller.abort()
    await activePoll
  }
  pollIfIdle()
}
