import { getGitHubApiBaseUrl, standardHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export async function getGitHubUser() {
  const response = await fetch(`${getGitHubApiBaseUrl()}/user`, {
    headers: {
      authorization: `token ${state.githubToken}`,
      ...standardHeaders(),
    },
  })

  if (!response.ok) throw new HTTPError("Failed to get GitHub user", response)

  return (await response.json()) as GithubUserResponse
}

// Trimmed for the sake of simplicity
interface GithubUserResponse {
  login: string
}
