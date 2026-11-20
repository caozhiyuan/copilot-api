import consola from "consola"

import { getConfig, reloadConfig } from "~/lib/config/config-store"
import { setupCopilotRuntime } from "~/lib/providers/copilot-runtime"
import {
  readGitHubToken,
  readGitHubTokenFromEnv,
} from "~/lib/auth/credential-store"
import { isGitHubCopilotEnabled } from "~/lib/providers/github-copilot-provider"
import { state } from "~/lib/state"
import {
  invalidateCodexRuntime,
  stopCopilotRefreshLoop,
} from "~/lib/auth/token"
import { stopModelsRefreshLoop } from "~/services/copilot/models-cache"

let pendingReload: Promise<void> = Promise.resolve()

async function applyConfigReload(): Promise<void> {
  const previousConfig = getConfig()
  const wasCopilotEnabled = isGitHubCopilotEnabled(previousConfig)
  const config = reloadConfig()

  // Credentials can change without changing accountId (signing in again).
  // The next Codex request reads the saved credentials and starts a fresh loop.
  invalidateCodexRuntime()
  if (!isGitHubCopilotEnabled(config)) {
    consola.debug(
      "Config reload: Copilot is disabled; stopping its refresh loop",
    )
    stopCopilotRefreshLoop()
    stopModelsRefreshLoop()
    return
  }

  const envToken = readGitHubTokenFromEnv()
  const githubToken =
    state.githubTokenSource === "cli" ?
      state.githubToken
    : (envToken ?? (await readGitHubToken()))

  if (!githubToken) {
    consola.debug(
      "Config reload: no GitHub token is available; clearing Copilot credentials",
    )
    stopCopilotRefreshLoop()
    // cacheModels() schedules its own timer that no AbortController owns.
    // Leaving it running would keep polling the Copilot models endpoint with
    // the credentials this branch just cleared, once per refresh interval.
    stopModelsRefreshLoop()
    state.githubToken = undefined
    state.copilotToken = undefined
    state.models = undefined
    state.userName = undefined
    state.copilotApiUrl = undefined
    state.tokenBasedBilling = undefined
    return
  }

  if (
    wasCopilotEnabled
    && githubToken === state.githubToken
    && state.copilotToken
    && state.models
  ) {
    consola.debug(
      "Config reload: GitHub token unchanged and Copilot runtime ready; keeping current credentials",
    )
    return
  }

  stopCopilotRefreshLoop()
  // The old Copilot runtime ends here rather than when its replacement
  // finishes initializing. setupCopilotRuntime() can fail before it reaches
  // cacheModels(), and a models loop left running would then repopulate the
  // credentials this branch is clearing, using the cleared Copilot token.
  stopModelsRefreshLoop()
  state.copilotToken = undefined
  state.models = undefined
  if (state.githubTokenSource !== "cli") {
    state.githubTokenSource = envToken ? "env" : "file"
  }
  consola.debug(
    `Config reload: initializing Copilot runtime with the ${state.githubTokenSource} GitHub token`,
  )
  await setupCopilotRuntime(githubToken)
  consola.debug("Config reload: Copilot runtime initialized")
}

export function reloadServerConfig(): Promise<void> {
  const reload = pendingReload.then(applyConfigReload)
  pendingReload = reload.catch(() => {})
  return reload
}
