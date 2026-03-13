import type { AccountContext } from "~/lib/types/account"

import { getGitHubApiBaseUrl, standardHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export async function getGitHubUser(account?: AccountContext) {
  // Use provided account or fall back to state (for legacy compatibility)
  const token = account?.githubToken ?? state.githubToken
  if (!token) {
    throw new Error("GitHub token not set")
  }

  const response = await fetch(`${getGitHubApiBaseUrl()}/user`, {
    headers: {
      authorization: `token ${token}`,
      ...standardHeaders(),
    },
  })

  if (!response.ok) throw new HTTPError("Failed to get GitHub user", response)

  return (await response.json()) as GithubUserResponse
}

// Trimmed for the sake of simplicity
export interface GithubUserResponse {
  login: string
}
