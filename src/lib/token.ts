import consola from "consola"
import fs from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

import { isOpencodeOauthApp } from "~/lib/api-config"
import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"

let copilotRefreshLoopController: AbortController | null = null

export const stopCopilotRefreshLoop = () => {
  if (!copilotRefreshLoopController) {
    return
  }

  copilotRefreshLoopController.abort()
  copilotRefreshLoopController = null
}

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

export const setupCopilotToken = async () => {
  if (isOpencodeOauthApp()) {
    if (!state.githubToken) throw new Error(`opencode token not found`)

    state.copilotToken = state.githubToken

    consola.debug("GitHub Copilot token set from opencode auth token")
    if (state.showToken) {
      consola.info("Copilot token:", state.copilotToken)
    }

    stopCopilotRefreshLoop()
    return
  }

  const { token, expires_at } = await getCopilotToken()
  state.copilotToken = token

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", token)
  }

  stopCopilotRefreshLoop()

  const controller = new AbortController()
  copilotRefreshLoopController = controller

  runCopilotRefreshLoop(expires_at, controller.signal)
    .catch(() => {
      consola.warn("Copilot token refresh loop stopped")
    })
    .finally(() => {
      if (copilotRefreshLoopController === controller) {
        copilotRefreshLoopController = null
      }
    })
}

// How often we wake up to check wall-clock time against the token expiry.
// Keeping this short ensures we recover quickly after a system sleep/wake cycle
// where the monotonic clock (used by setTimeout) does not advance.
const REFRESH_POLL_INTERVAL_MS = 30_000

const runCopilotRefreshLoop = async (
  expiresAt: number,
  signal: AbortSignal,
) => {
  // expiresAt is a Unix timestamp in seconds from the GitHub API.
  // Refresh 60 seconds before expiry to avoid using a token that is about to expire.
  let refreshAtMs = expiresAt * 1000 - 60_000

  while (!signal.aborted) {
    // Sleep in short chunks so a wake-from-sleep is detected within REFRESH_POLL_INTERVAL_MS.
    // setTimeout uses the monotonic clock on Linux (Docker), which does not advance during
    // system sleep, so a single long sleep would never fire after the laptop wakes up.
    const msUntilRefresh = refreshAtMs - Date.now()
    if (msUntilRefresh > 0) {
      await delay(
        Math.min(msUntilRefresh, REFRESH_POLL_INTERVAL_MS),
        undefined,
        {
          signal,
        },
      )
      continue
    }

    consola.debug("Refreshing Copilot token")

    try {
      const { token, expires_at } = await getCopilotToken()
      state.copilotToken = token
      refreshAtMs = expires_at * 1000 - 60_000
      consola.debug("Copilot token refreshed")
      if (state.showToken) {
        consola.info("Refreshed Copilot token:", token)
      }
    } catch (error) {
      consola.error("Failed to refresh Copilot token:", error)
      refreshAtMs = Date.now() + 15_000
      consola.warn("Retrying Copilot token refresh in 15s")
    }
  }
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }
      await logUser()

      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

export async function logUser() {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)

  const copilotUser = await getCopilotUsage()
  state.copilotApiUrl = copilotUser.endpoints.api
}
