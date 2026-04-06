import type { AccountContext } from "~/lib/types/account"

import { getGitHubApiBaseUrl, githubUserHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { accountFromState, state } from "~/lib/state"

const resolveGitHubUserAccount = (account?: AccountContext): AccountContext => {
  if (account) {
    return account
  }

  if (!state.githubToken) {
    throw new Error("GitHub token not set")
  }

  return accountFromState()
}

export async function getGitHubUser(account?: AccountContext) {
  const resolvedAccount = resolveGitHubUserAccount(account)

  const response = await fetch(`${getGitHubApiBaseUrl()}/user`, {
    headers: githubUserHeaders(resolvedAccount),
  })

  if (!response.ok) throw new HTTPError("Failed to get GitHub user", response)

  return (await response.json()) as GithubUserResponse
}

// Trimmed for the sake of simplicity
export interface GithubUserResponse {
  login: string
}
