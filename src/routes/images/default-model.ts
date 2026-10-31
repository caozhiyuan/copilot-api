import { HTTPError } from "~/lib/error"
import { isGitHubCopilotAvailable } from "~/lib/github-copilot-provider"
import {
  DEFAULT_IMAGE_MODELS,
  getDefaultImageModel,
  IMAGE_PROVIDER_PRIORITY,
  type ImageProvider,
} from "~/lib/image-models"
import { resolveProviderConfig } from "~/lib/provider-resolver"

/** Resolve the three supported image models before sending the request. */
export async function resolveImageRequestModel(
  requestedModel: string | undefined,
  options: {
    provider?: string
    resolveProviderConfig?: typeof resolveProviderConfig
    isGitHubCopilotAvailable?: typeof isGitHubCopilotAvailable
  } = {},
): Promise<string> {
  if (options.provider) {
    const model = getDefaultImageModel(options.provider)
    if (model) return model
  }

  const availability = new Map<ImageProvider, Promise<boolean>>()
  const isAvailable = (provider: ImageProvider): Promise<boolean> => {
    let pending = availability.get(provider)
    if (!pending) {
      pending =
        provider === "github-copilot" ?
          Promise.resolve(
            (options.isGitHubCopilotAvailable ?? isGitHubCopilotAvailable)(),
          )
        : (options.resolveProviderConfig ?? resolveProviderConfig)(
            provider,
          ).then((config) => config !== null)
      availability.set(provider, pending)
    }
    return pending
  }

  const requested = requestedModel?.trim()
  const selected = IMAGE_PROVIDER_PRIORITY.find(
    (provider) =>
      requested === DEFAULT_IMAGE_MODELS[provider]
      || requested === `${provider}/${DEFAULT_IMAGE_MODELS[provider]}`,
  )
  if (selected && (await isAvailable(selected))) {
    return `${selected}/${DEFAULT_IMAGE_MODELS[selected]}`
  }
  for (const provider of IMAGE_PROVIDER_PRIORITY) {
    if (await isAvailable(provider)) {
      return `${provider}/${DEFAULT_IMAGE_MODELS[provider]}`
    }
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
