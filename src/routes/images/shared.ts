import consola from "consola"
import type { Context } from "hono"

import { resolveMappedModel, type ResolvedProviderConfig } from "~/lib/config"
import { forwardError, HTTPError } from "~/lib/error"
import {
  GITHUB_COPILOT_PROVIDER,
  isGitHubCopilotAvailable,
} from "~/lib/github-copilot-provider"
import { prepareImageJsonRequest } from "~/lib/image-json-request"
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

export function imageEditContentTypeErrorResponse(c: Context): Response | null {
  const mediaType = c.req
    .header("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase()
  if (mediaType === "application/json" || mediaType === "multipart/form-data")
    return null

  return c.json(
    {
      error: {
        message: "Image edits require application/json or multipart/form-data",
        type: "invalid_request_error",
      },
    },
    415,
  )
}

function getContentMetadata(headers: Headers) {
  return {
    contentType: headers.get("content-type"),
    contentLength: headers.get("content-length"),
  }
}

/**
 * Snapshots generated request headers before consuming the body.
 */
export function snapshotRequestHeaders(request: Request): Headers {
  return new Headers(request.headers)
}

/**
 * Rebuilds a request from primitives instead of cloning: under Node runtimes
 * srvx wraps incoming requests in a proxy class whose prototype chain
 * satisfies `instanceof Request` without the native internals, so
 * `new Request(request)` throws.
 */
export function createForwardRequest(
  request: Request,
  requestHeaders: Headers,
  body: Bun.BodyInit | null,
): Request {
  const init: RequestInit & { duplex: "half" } = {
    body,
    duplex: "half",
    headers: requestHeaders,
    method: request.method,
    signal: request.signal,
  }
  return new Request(request.url, init)
}

/**
 * Parses an image request body as JSON, retaining the original bytes for
 * unchanged forwarding while allowing model mapping to rebuild the payload.
 * Rebuilt bodies stay binary so Node does not synthesize a text/plain content type.
 */
export async function parseJsonImagesRequest(
  request: Request,
): Promise<ParsedImagesRequest | Request> {
  const parsed = await prepareImageJsonRequest(request)
  return parsed.valid ? parsed : parsed.originalRequest
}

/**
 * Handles Codex images proxying. Pass a resolvedProviderConfig when the
 * caller already resolved the codex provider to avoid a second resolve, and
 * pass a request when model mapping rebuilt the request body.
 */
export async function handleCodexImages(
  c: Context,
  operation: CodexImagesOperation,
  resolvedProviderConfig?: ResolvedProviderConfig,
  request: Request = c.req.raw,
  model?: string,
): Promise<Response> {
  try {
    const codexProviderConfig =
      resolvedProviderConfig
      ?? (await imageRouteDependencies.resolveProviderConfig("codex"))
    if (!codexProviderConfig) {
      await request.body?.cancel().catch(() => {})
      return c.json(
        {
          error: {
            message: "Provider 'codex' not found or disabled",
            type: "invalid_request_error",
          },
        },
        404,
      )
    }

    let actualModel = model
    if (
      actualModel === undefined
      && !request.headers.get("content-type")?.includes("multipart/form-data")
    ) {
      const parsed = await prepareImageJsonRequest(request)
      actualModel =
        parsed.valid ? (parsed.model ?? DEFAULT_CODEX_IMAGE_MODEL) : "unknown"
      request = parsed.originalRequest
    }
    actualModel ??= "unknown"
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
      model: actualModel,
      operation,
      providerConfig: codexProviderConfig,
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
 * Applies model mappings and resolves unknown or absent models to an available
 * provider's image default before dispatching.
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
