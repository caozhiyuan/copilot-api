import consola from "consola"
import type { Context } from "hono"

import { resolveMappedModel, type ResolvedProviderConfig } from "~/lib/config"
import { forwardError } from "~/lib/error"
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

export const logger = createHandlerLogger("images-handler")

export const imageRouteDependencies = {
  debugJsonAsync,
  getImageEditModel,
  getImageGenerationModel,
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
 * Routes a parsed images request: applies the model mapping, forwards to a
 * mapped provider when configured, and otherwise falls back to Codex.
 */
export async function routeImagesRequest(
  c: Context,
  operation: CodexImagesOperation,
  parsed: ParsedImagesRequest,
): Promise<Response> {
  const requestedModel = parsed.model
  if (requestedModel === undefined) {
    return await handleCodexImages(
      c,
      operation,
      undefined,
      parsed.originalRequest
        ?? (await parsed.createRequest(DEFAULT_CODEX_IMAGE_MODEL)),
      DEFAULT_CODEX_IMAGE_MODEL,
    )
  }
  const mappedModel = imageRouteDependencies.resolveMappedModel(requestedModel)
  if (mappedModel !== requestedModel) {
    consola.debug(`Resolved model mapping: ${requestedModel} -> ${mappedModel}`)
  }

  const providerModelAlias = parseProviderModelAlias(mappedModel)
  if (providerModelAlias) {
    const providerConfig = await imageRouteDependencies.resolveProviderConfig(
      providerModelAlias.provider,
    )
    if (providerConfig) {
      const request =
        providerConfig.name === "xai" && parsed.originalRequest ?
          parsed.originalRequest
        : await parsed.createRequest(
            providerModelAlias.model,
            providerConfig.name,
          )
      if (providerConfig.name === "codex") {
        return await handleCodexImages(
          c,
          operation,
          providerConfig,
          request,
          providerModelAlias.model,
        )
      }
      if (providerConfig.name === "xai") {
        const translated = await translateXaiImageJsonRequest(
          request,
          operation,
          providerModelAlias.model,
        )
        return await forwardXaiImagesWithLogging(
          providerConfig,
          request,
          operation,
          translated.payload,
          {
            logger,
            provider: providerModelAlias.provider,
            model: providerModelAlias.model,
          },
          translated.body,
        )
      }

      return await forwardProviderImagesWithLogging(
        providerConfig,
        request,
        operation,
        {
          logger,
          provider: providerModelAlias.provider,
          model: providerModelAlias.model,
        },
      )
    }

    // The mapped provider is not configured: keep the pre-mapping behavior
    // and forward the client-sent model to Codex, not the prefixed alias.
    consola.debug(
      `Provider '${providerModelAlias.provider}' not found or disabled; forwarding the original model to Codex`,
    )
    return await handleCodexImages(
      c,
      operation,
      undefined,
      parsed.originalRequest ?? (await parsed.createRequest(requestedModel)),
      requestedModel,
    )
  }

  if (parsed.originalRequest && mappedModel === requestedModel) {
    return await handleCodexImages(
      c,
      operation,
      undefined,
      parsed.originalRequest,
      requestedModel,
    )
  }

  return await handleCodexImages(
    c,
    operation,
    undefined,
    await parsed.createRequest(mappedModel),
    mappedModel,
  )
}
