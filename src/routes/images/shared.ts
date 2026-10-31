import consola from "consola"

import { resolveMappedModel } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import {
  GITHUB_COPILOT_PROVIDER,
  isGitHubCopilotAvailable,
} from "~/lib/github-copilot-provider"
import { createHandlerLogger } from "~/lib/logger"
import type { ProviderModelAlias } from "~/lib/provider-model"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import {
  forwardCopilotImagesWithLogging,
  forwardProviderImagesWithLogging,
  forwardXaiImagesWithLogging,
} from "~/routes/images/forward-provider-images"
import type { CodexImagesOperation } from "~/services/codex/images"
import { translateXaiImageJsonRequest } from "~/routes/images/xai-json-request"
import { resolveImageRequestModel } from "~/routes/images/default-model"

export const logger = createHandlerLogger("images-handler")

export const imageRouteDependencies = {
  isGitHubCopilotAvailable,
  resolveMappedModel,
  resolveProviderConfig,
}

export interface ParsedImagesRequest {
  /** Rebuilds the forwarding request with the resolved model in the body. */
  createRequest: (
    model: string,
    provider?: string,
  ) => Request | Promise<Request>
  model: string | undefined
  /** Unchanged request, forwarded as-is when no rebuild is needed. */
  originalRequest?: Request
}

/**
 * Apply model mappings and resolve automatic defaults before dispatching.
 * Explicit targets retain their model and never fall back to another provider.
 */
export async function routeImagesRequest(
  operation: CodexImagesOperation,
  parsed: ParsedImagesRequest,
): Promise<Response> {
  let alias: ProviderModelAlias
  try {
    alias = await resolveImageRequestModel(
      parsed.model?.trim() ?
        imageRouteDependencies.resolveMappedModel(parsed.model.trim())
      : undefined,
      {
        resolveProviderConfig: imageRouteDependencies.resolveProviderConfig,
        isGitHubCopilotAvailable:
          imageRouteDependencies.isGitHubCopilotAvailable,
      },
    )
  } catch (error) {
    await parsed.originalRequest?.body?.cancel().catch(() => {})
    throw error
  }

  consola.debug(
    `Resolved image model: ${parsed.model ?? "(default)"} -> ${alias.provider}/${alias.model}`,
  )
  const request =
    (
      parsed.originalRequest
      && (alias.provider === "xai" || parsed.model === alias.model)
    ) ?
      parsed.originalRequest
    : await parsed.createRequest(alias.model, alias.provider)

  if (alias.provider === GITHUB_COPILOT_PROVIDER) {
    return await forwardCopilotImagesWithLogging(request, operation, {
      logger,
      ...alias,
    })
  }

  const providerConfig = await imageRouteDependencies.resolveProviderConfig(
    alias.provider,
  )
  if (!providerConfig) {
    await request.body?.cancel().catch(() => {})
    throw new HTTPError(
      `Provider '${alias.provider}' not found or disabled`,
      Response.json(
        {
          error: {
            message: `Provider '${alias.provider}' not found or disabled`,
            type: "invalid_request_error",
          },
        },
        { status: 404 },
      ),
    )
  }
  if (alias.provider !== "xai") {
    return await forwardProviderImagesWithLogging(
      providerConfig,
      request,
      operation,
      { logger, ...alias },
    )
  }

  const translated = await translateXaiImageJsonRequest(
    request,
    operation,
    alias.model,
  )
  return await forwardXaiImagesWithLogging(
    providerConfig,
    request,
    operation,
    translated.payload,
    { logger, ...alias },
    translated.body,
  )
}
