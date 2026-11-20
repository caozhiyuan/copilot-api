import { getConfig, type AppConfig } from "../config/config-store"
import { HTTPError } from "../http/http-error"
import { state, type State } from "../state"

export const GITHUB_COPILOT_PROVIDER = "github-copilot"

// Missing configuration preserves the legacy builtin Copilot behavior.
export function isGitHubCopilotEnabled(
  config: AppConfig = getConfig(),
): boolean {
  return config.providers?.[GITHUB_COPILOT_PROVIDER]?.enabled !== false
}

// Provider-only mode may leave Copilot enabled without loading its credentials.
export function isGitHubCopilotAvailable(
  config: AppConfig = getConfig(),
  runtime: Pick<State, "githubToken" | "copilotToken"> = state,
): boolean {
  return (
    isGitHubCopilotEnabled(config)
    && Boolean(runtime.githubToken && runtime.copilotToken)
  )
}

export function assertGitHubCopilotEnabled(): void {
  if (!isGitHubCopilotEnabled()) {
    throw new HTTPError(
      "GitHub Copilot provider is disabled",
      Response.json(
        {
          error: {
            message: "GitHub Copilot provider is disabled",
            type: "provider_disabled",
          },
        },
        { status: 403 },
      ),
    )
  }
}
