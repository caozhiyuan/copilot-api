import consola from "consola"
import type { Context } from "hono"

import { resolveMappedModel, type ResolvedProviderConfig } from "~/lib/config"
import { forwardError, HTTPError } from "~/lib/error"
import {
  GITHUB_COPILOT_PROVIDER,
  isGitHubCopilotAvailable,
} from "~/lib/github-copilot-provider"
import { createHandlerLogger, debugJson, debugJsonAsync } from "~/lib/logger"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { observeImagesResponse } from "~/lib/token-usage/images"
import {
  getImageEditModel,
  getImageGenerationModel,
} from "~/lib/xai-image-model"
import {
  forwardCopilotImagesWithLogging,
  forwardProviderImagesWithLogging,
  forwardXaiImagesWithLogging,
} from "~/routes/images/forward-provider-images"
import { logImageEditRequest } from "~/routes/images/request-logging"
import {
  DEFAULT_CODEX_IMAGE_MODEL,
  forwardCodexImages,
  type CodexImagesOperation,
} from "~/services/codex/images"
import { translateXaiImageJsonRequest } from "~/routes/images/xai-json-request"
import { resolveImageRequestModel } from "~/routes/images/default-model"

export const logger = createHandlerLogger("images-handler")

export const imageRouteDependencies = {
  debugJsonAsync,
  getImageEditModel,
  getImageGenerationModel,
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

function getContentMetadata(headers: Headers) {
  return {
    contentType: headers.get("content-type"),
    contentLength: headers.get("content-length"),
  }
}

/** Forward an already prepared Codex image request without parsing it again. */
export async function handleCodexImages(
  c: Context,
  operation: CodexImagesOperation,
  providerConfig: ResolvedProviderConfig,
  request: Request,
  model: string = DEFAULT_CODEX_IMAGE_MODEL,
): Promise<Response> {
  try {
    request = await logImageEditRequest(
      logger,
      `images.${operation}.codex.request`,
      request,
      {},
      imageRouteDependencies.debugJsonAsync,
    )

    const upstreamResponse = await forwardCodexImages(request, operation)
    debugJson(logger, `images.${operation}.codex.response`, {
      ...getContentMetadata(upstreamResponse.headers),
      statusCode: upstreamResponse.status,
    })
    return observeImagesResponse(upstreamResponse, {
      model,
      operation,
      providerConfig,
      onMetadata: (metadata) =>
        debugJson(logger, `images.${operation}.codex.response.body`, metadata),
    })
  } catch (error) {
    await request.body?.cancel().catch(() => {})
    logger.error(`images.${operation}.codex.error`, { error })
    return await forwardError(c, error)
  }
}

/**
 * Apply model mappings and resolve automatic defaults before dispatching.
 * Explicit targets retain their model and never fall back to another provider.
 */
export async function routeImagesRequest(
  c: Context,
  operation: CodexImagesOperation,
  parsed: ParsedImagesRequest,
): Promise<Response> {
  let resolvedModel: string
  try {
    resolvedModel = await resolveImageRequestModel(
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

  const alias = parseProviderModelAlias(resolvedModel)
  if (!alias) throw new Error("Invalid resolved image model")
  consola.debug(
    `Resolved image model: ${parsed.model ?? "(default)"} -> ${resolvedModel}`,
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
  if (alias.provider === "codex") {
    return await handleCodexImages(
      c,
      operation,
      providerConfig,
      request,
      alias.model,
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
