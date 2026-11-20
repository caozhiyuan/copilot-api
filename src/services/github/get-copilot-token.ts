import consola from "consola"

import { getGitHubApiBaseUrl, githubHeaders } from "~/lib/providers/api-config"
import { HTTPError } from "~/lib/http/http-error"
import { state } from "~/lib/state"

export const getCopilotToken = async () => {
  const response = await fetch(
    `${getGitHubApiBaseUrl()}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(state),
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
