import { HTTPError } from "~/lib/error"
import { isGitHubCopilotAvailable } from "~/lib/github-copilot-provider"
import {
  DEFAULT_IMAGE_MODELS,
  IMAGE_PROVIDER_PRIORITY,
} from "~/lib/image-models"
import {
  parseProviderModelAlias,
  type ProviderModelAlias,
} from "~/lib/provider-model"
import { resolveProviderConfig } from "~/lib/provider-resolver"

/** Only missing models and bare gpt-image-2 select an available default. */
export async function resolveImageRequestModel(
  requestedModel: string | undefined,
  options: {
    resolveProviderConfig?: typeof resolveProviderConfig
    isGitHubCopilotAvailable?: typeof isGitHubCopilotAvailable
  } = {},
): Promise<ProviderModelAlias> {
  const requested = requestedModel?.trim()
  if (requested && requested !== DEFAULT_IMAGE_MODELS.codex) {
    const alias = parseProviderModelAlias(requested)
    if (alias) return alias

    return { provider: "codex", model: requested }
  }

  for (const provider of IMAGE_PROVIDER_PRIORITY) {
    const available =
      provider === "github-copilot" ?
        (options.isGitHubCopilotAvailable ?? isGitHubCopilotAvailable)()
      : (await (options.resolveProviderConfig ?? resolveProviderConfig)(
          provider,
        )) !== null
    if (available) return { provider, model: DEFAULT_IMAGE_MODELS[provider] }
  }
  throw new HTTPError(
    "No enabled image provider is available",
    Response.json(
      {
        error: {
          message: "No enabled image provider is available",
          type: "invalid_request_error",
        },
      },
      { status: 404 },
    ),
  )
}
