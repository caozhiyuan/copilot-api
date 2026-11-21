import consola from "consola"

import { getGitHubApiBaseUrl, githubHeaders } from "~/lib/providers/api-config"
import { HTTPError } from "~/lib/http/http-error"
import { state } from "~/lib/state"

const COPILOT_TOKEN_REQUEST_TIMEOUT_MS = 15_000

export interface GetCopilotTokenOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export const getCopilotToken = async (options: GetCopilotTokenOptions = {}) => {
  const timeoutMs = options.timeoutMs ?? COPILOT_TOKEN_REQUEST_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal =
    options.signal ?
      AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal

  const response = await fetch(
    `${getGitHubApiBaseUrl()}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(state),
      signal,
    },
  )

  if (!response.ok) {
    const errorText = await response.clone().text()
    consola.error("Failed to get Copilot token response body", errorText)

    throw new HTTPError("Failed to get Copilot token", response)
  }

  return (await response.json()) as GetCopilotTokenResponse
}

// Trimmed for the sake of simplicity
export interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
  // Per-SKU isolated endpoints returned by the token exchange. This is the
  // authoritative routing source for the issued token; `/copilot_internal/user`
  // may advertise a different segmented host (e.g. business vs enterprise).
  endpoints?: {
    api?: string
    proxy?: string
    telemetry?: string
  }
}
