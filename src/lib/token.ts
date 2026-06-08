import consola from "consola"
import { setTimeout as delay } from "node:timers/promises"

import { isOpencodeOauthApp } from "~/lib/api-config"
import { getRawProviderConfig, setProviderConfig } from "~/lib/config"
import {
  readCodexCredentials,
  readGitHubToken,
  writeCodexCredentials,
  writeGitHubToken,
} from "~/lib/credential-store"
import {
  isCodexCredentialsExpired,
  refreshCodexCredentials,
  type CodexCredentials,
} from "~/lib/oauth/codex"
import { CODEX_API_BASE_URL } from "~/services/codex/create-responses"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"

let copilotRefreshLoopController: AbortController | null = null
let codexRefreshLoopController: AbortController | null = null

export const stopCopilotRefreshLoop = () => {
  if (!copilotRefreshLoopController) {
    return
  }

  copilotRefreshLoopController.abort()
  copilotRefreshLoopController = null
}

export const stopCodexRefreshLoop = () => {
  if (!codexRefreshLoopController) {
    return
  }

  codexRefreshLoopController.abort()
  codexRefreshLoopController = null
}

function applyCodexCredentials(credentials: CodexCredentials): void {
  state.codexAccessToken = credentials.accessToken
  state.codexRefreshToken = credentials.refreshToken
  state.codexExpiresAt = credentials.expiresAt
  state.codexAccountId = credentials.accountId

  consola.debug("Codex credentials loaded successfully")
  if (state.showToken) {
    consola.info("Codex access token:", credentials.accessToken)
  }
}

function getLoadedCodexCredentials(): CodexCredentials | null {
  if (
    !state.codexAccessToken
    || !state.codexRefreshToken
    || !state.codexExpiresAt
    || !state.codexAccountId
  ) {
    return null
  }

  return {
    accessToken: state.codexAccessToken,
    refreshToken: state.codexRefreshToken,
    expiresAt: state.codexExpiresAt,
    accountId: state.codexAccountId,
  }
}

function syncCodexProviderConfig(options?: { enabled?: boolean }): void {
  const existingProviderConfig = getRawProviderConfig("codex") ?? {}
  setProviderConfig("codex", {
    ...existingProviderConfig,
    type: "openai-responses",
    enabled: options?.enabled ?? existingProviderConfig.enabled,
    baseUrl: CODEX_API_BASE_URL,
    authType: "oauth2",
  })
}

export async function persistCodexCredentials(
  credentials: CodexCredentials,
  options?: { enableProvider?: boolean },
): Promise<void> {
  await writeCodexCredentials(credentials)
  syncCodexProviderConfig({
    enabled: options?.enableProvider ? true : undefined,
  })
  applyCodexCredentials(credentials)
}

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

  const { token, refresh_in } = await getCopilotToken()
  state.copilotToken = token

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", token)
  }

  stopCopilotRefreshLoop()

  const controller = new AbortController()
  copilotRefreshLoopController = controller

  runCopilotRefreshLoop(refresh_in, controller.signal)
    .catch(() => {
      consola.warn("Copilot token refresh loop stopped")
    })
    .finally(() => {
      if (copilotRefreshLoopController === controller) {
        copilotRefreshLoopController = null
      }
    })
}

export const setupCodexToken = async (): Promise<void> => {
  const loadedCredentials = getLoadedCodexCredentials()
  if (loadedCredentials && !isCodexCredentialsExpired(loadedCredentials)) {
    if (codexRefreshLoopController) {
      return
    }

    applyCodexCredentials(loadedCredentials)
  }

  const credentials = loadedCredentials ?? (await readCodexCredentials())
  if (!credentials) {
    throw new Error(
      `Codex credentials not found. Run \`copilot-api auth login --provider codex\` first.`,
    )
  }

  syncCodexProviderConfig()

  let nextCredentials = credentials
  if (isCodexCredentialsExpired(credentials)) {
    consola.debug("Refreshing expired Codex credentials")
    nextCredentials = await refreshCodexCredentials(credentials)
    await persistCodexCredentials(nextCredentials)
  }

  applyCodexCredentials(nextCredentials)
  stopCodexRefreshLoop()

  const controller = new AbortController()
  codexRefreshLoopController = controller

  runCodexRefreshLoop(controller.signal)
    .catch(() => {
      consola.warn("Codex token refresh loop stopped")
    })
    .finally(() => {
      if (codexRefreshLoopController === controller) {
        codexRefreshLoopController = null
      }
    })
}

const REFRESH_POLL_INTERVAL_MS = 15_000
const EARLY_REFRESH_BUFFER_MS = 60_000
const RETRY_REFRESH_DELAY_MS = 15_000
const MAX_RETRY_REFRESH_DELAY_MS = 600_000
const RETRY_REFRESH_JITTER_MS = 15_000
const MIN_REFRESH_DELAY_MS = 1_000

export const getRefreshDeadlineMs = (
  refreshIn: number,
  nowMs: number = Date.now(),
) =>
  nowMs
  + Math.max(refreshIn * 1000 - EARLY_REFRESH_BUFFER_MS, MIN_REFRESH_DELAY_MS)

// Use short wall-clock chunks so the next wake after sleep notices elapsed time
// quickly, without relying on the server's absolute expires_at matching local time.
export const getRefreshPollDelayMs = (
  refreshAtMs: number,
  nowMs: number = Date.now(),
) => Math.min(Math.max(refreshAtMs - nowMs, 0), REFRESH_POLL_INTERVAL_MS)

const runCopilotRefreshLoop = async (
  refreshIn: number,
  signal: AbortSignal,
) => {
  let refreshAtMs = getRefreshDeadlineMs(refreshIn)
  let retryDelayMs = RETRY_REFRESH_DELAY_MS

  while (!signal.aborted) {
    const nextDelayMs = getRefreshPollDelayMs(refreshAtMs)
    if (nextDelayMs > 0) {
      await delay(nextDelayMs, undefined, { signal })
      continue
    }

    consola.debug("Refreshing Copilot token")

    try {
      const { token, refresh_in } = await getCopilotToken()
      state.copilotToken = token
      refreshAtMs = getRefreshDeadlineMs(refresh_in)
      retryDelayMs = RETRY_REFRESH_DELAY_MS
      consola.debug("Copilot token refreshed")
      if (state.showToken) {
        consola.info("Refreshed Copilot token:", token)
      }
    } catch (error) {
      consola.error("Failed to refresh Copilot token:", error)
      const delayMs = Math.min(
        retryDelayMs + Math.floor(Math.random() * RETRY_REFRESH_JITTER_MS),
        MAX_RETRY_REFRESH_DELAY_MS,
      )
      refreshAtMs = Date.now() + delayMs
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_REFRESH_DELAY_MS)
      consola.warn(
        `Retrying Copilot token refresh in ${Math.round(delayMs / 1000)}s`,
      )
    }
  }
}

const runCodexRefreshLoop = async (signal: AbortSignal) => {
  let refreshAtMs = Math.max(
    (state.codexExpiresAt ?? Date.now()) - EARLY_REFRESH_BUFFER_MS,
    Date.now(),
  )

  while (!signal.aborted) {
    const expiresAt = state.codexExpiresAt
    const refreshToken = state.codexRefreshToken
    if (!expiresAt || !refreshToken) {
      return
    }

    const nextDelayMs = getRefreshPollDelayMs(refreshAtMs)
    if (nextDelayMs > 0) {
      await delay(nextDelayMs, undefined, { signal })
      continue
    }

    consola.debug("Refreshing Codex credentials")

    try {
      const credentials = await refreshCodexCredentials({
        accessToken: state.codexAccessToken ?? "",
        refreshToken,
        expiresAt,
        accountId: state.codexAccountId ?? "",
      })
      await persistCodexCredentials(credentials)
      refreshAtMs = Math.max(
        credentials.expiresAt - EARLY_REFRESH_BUFFER_MS,
        Date.now(),
      )
      consola.debug("Codex credentials refreshed")
    } catch (error) {
      consola.error("Failed to refresh Codex credentials:", error)
      refreshAtMs = Date.now() + RETRY_REFRESH_DELAY_MS
      consola.warn(
        `Retrying Codex token refresh in ${RETRY_REFRESH_DELAY_MS / 1000}s`,
      )
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
    const githubToken = await readGitHubToken()

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
    await writeGitHubToken(token)
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
  state.userName = user.login
  consola.info(`Logged in as ${user.login}`)

  const copilotUser = await getCopilotUsage()
  state.copilotApiUrl = copilotUser.endpoints.api
  state.tokenBasedBilling = copilotUser.token_based_billing
}
