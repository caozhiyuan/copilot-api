import consola from "consola"

import { state } from "~/lib/state"
import { getModels as getCopilotModels } from "~/services/copilot/get-models"

// Periodically refresh models so long-running daemons pick up new SKUs.
const MODELS_REFRESH_BASE_MS = 30 * 60 * 1000
let modelsRefreshTimer: ReturnType<typeof setTimeout> | null = null
// This loop runs on a plain timer that no AbortController owns, so stopping it
// cannot cancel a response that is already on the wire. The generation lets a
// stopped loop neither write state.models nor schedule itself again.
let refreshGeneration = 0

const cancelModelsRefreshTimer = () => {
  if (modelsRefreshTimer) {
    clearTimeout(modelsRefreshTimer)
    modelsRefreshTimer = null
  }
}

export const stopModelsRefreshLoop = () => {
  // Bump before cancelling so a refresh already awaiting its response sees a
  // different generation and drops both its result and its next tick.
  refreshGeneration++
  cancelModelsRefreshTimer()
}

type ModelsFetcher = typeof getCopilotModels

const refreshModels = async (fetcher: ModelsFetcher, generation: number) => {
  const prevIds = new Set(state.models?.data.map((m) => m.id) ?? [])
  const models = await fetcher()
  if (generation !== refreshGeneration) return

  state.models = {
    ...models,
    data: models.data.filter(
      (model) =>
        model.policy?.state !== "disabled"
        && (model.model_picker_enabled
          || model.capabilities.type === "embeddings"),
    ),
  }
  const nextIds = state.models.data.map((m) => m.id)
  const added = nextIds.filter((id) => !prevIds.has(id))
  if (added.length > 0) {
    consola.info(`Models refresh: ${added.length} new`)
  } else {
    consola.debug(`Models refresh: no changes (${nextIds.length} total)`)
  }
}

// Startup used to end with a plain "Available models" dump that was dropped
// when the Copilot setup moved into setupCopilotRuntime(). A fresh terminal
// now only sees "Models refresh: N new", which never tells the operator which
// IDs the gateway accepts. Periodic refreshes stay quiet so this stays a
// one-shot startup banner instead of repeating every 30 minutes.
export function logAvailableModels(): void {
  const models = state.models?.data ?? []
  if (models.length === 0) {
    consola.warn(
      "No Copilot models available. Check that the account has Copilot access.",
    )
    return
  }

  const entries = models.map((model) => `- ${model.id}`).join("\n")
  consola.info(`Available models (${models.length}):\n${entries}`)
}

const scheduleModelsRefresh = (fetcher: ModelsFetcher, intervalMs: number) => {
  const generation = refreshGeneration
  const jitter = Math.floor(Math.random() * (intervalMs / 6))
  const delay = intervalMs + jitter
  consola.debug(
    `Scheduling next models refresh in ${Math.round(delay / 1000)} seconds`,
  )

  cancelModelsRefreshTimer()
  modelsRefreshTimer = setTimeout(async () => {
    try {
      await refreshModels(fetcher, generation)
    } catch (error) {
      if (generation === refreshGeneration) {
        consola.warn("Failed to refresh models, keeping previous cache.", error)
      }
    } finally {
      if (generation === refreshGeneration) {
        scheduleModelsRefresh(fetcher, intervalMs)
      }
    }
  }, delay)
}

export async function cacheModels(
  fetcher: ModelsFetcher = getCopilotModels,
  intervalMs: number = MODELS_REFRESH_BASE_MS,
): Promise<void> {
  // A fresh population supersedes whatever the previous loop was doing. This
  // is the path a config reload takes when the GitHub token changes, so a
  // request still in flight for the old account must not join this generation
  // and overwrite state.models once it comes back.
  refreshGeneration++
  const generation = refreshGeneration
  await refreshModels(fetcher, generation)
  if (generation !== refreshGeneration) return

  scheduleModelsRefresh(fetcher, intervalMs)
}
