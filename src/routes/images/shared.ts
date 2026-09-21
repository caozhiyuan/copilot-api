import consola from "consola"
import type { Context } from "hono"

import { resolveMappedModel, type ResolvedProviderConfig } from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger, debugJson, debugJsonAsync } from "~/lib/logger"
import { assertAllowedModel } from "~/lib/model-admission"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { forwardProviderImagesWithLogging } from "~/routes/images/forward-provider-images"
import {
  forwardCodexImages,
  type CodexImagesOperation,
} from "~/services/codex/images"
import { createProviderProxyResponse } from "~/services/providers/provider-proxy"

export const logger = createHandlerLogger("images-handler")

export const imageRouteDependencies = {
  debugJsonAsync,
  resolveMappedModel,
  resolveProviderConfig,
}

export interface ParsedImagesRequest {
  /** Rebuilds the forwarding request with the resolved model in the body. */
  createRequest: (model: string) => Request
  model: string
}

function getContentMetadata(headers: Headers) {
  return {
    contentType: headers.get("content-type"),
    contentLength: headers.get("content-length"),
  }
}

/**
 * Snapshots request headers before the body is consumed: Bun drops
 * auto-generated body headers (like the multipart boundary) afterwards.
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
 * Handles Codex images proxying. Pass a resolvedProviderConfig when the
 * caller already resolved the codex provider to avoid a second resolve, and
 * pass a request when model mapping rebuilt the request body.
 */
export async function handleCodexImages(
  c: Context,
  operation: CodexImagesOperation,
  resolvedProviderConfig?: ResolvedProviderConfig,
  request: Request = c.req.raw,
): Promise<Response> {
  try {
    const codexProviderConfig =
      resolvedProviderConfig
      ?? (await imageRouteDependencies.resolveProviderConfig("codex"))
    if (!codexProviderConfig) {
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

    if (operation === "generations") {
      await imageRouteDependencies.debugJsonAsync(
        logger,
        "images.generations.codex.request",
        async () => ({
          body: await request.clone().text(),
        }),
      )
    } else {
      debugJson(
        logger,
        "images.edits.codex.request",
        getContentMetadata(request.headers),
      )
    }

    const upstreamResponse = await forwardCodexImages(request, operation)
    debugJson(logger, `images.${operation}.codex.response`, {
      ...getContentMetadata(upstreamResponse.headers),
      statusCode: upstreamResponse.status,
    })
    return createProviderProxyResponse(upstreamResponse)
  } catch (error) {
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
  const mappedModel = imageRouteDependencies.resolveMappedModel(requestedModel)
  assertAllowedModel(mappedModel)
  if (mappedModel !== requestedModel) {
    consola.debug(`Resolved model mapping: ${requestedModel} -> ${mappedModel}`)
  }

  const providerModelAlias = parseProviderModelAlias(mappedModel)
  if (providerModelAlias) {
    const providerConfig = await imageRouteDependencies.resolveProviderConfig(
      providerModelAlias.provider,
    )
    if (providerConfig) {
      const request = parsed.createRequest(providerModelAlias.model)
      if (providerConfig.name === "codex") {
        return await handleCodexImages(c, operation, providerConfig, request)
      }

      return await forwardProviderImagesWithLogging(
        providerConfig,
        request,
        operation,
        { logger, provider: providerModelAlias.provider },
      )
    }

    // The mapped provider is not configured: keep the pre-mapping behavior
    // and forward the client-sent model to Codex, not the prefixed alias.
    consola.debug(
      `Provider '${providerModelAlias.provider}' not found or disabled; forwarding the original model to Codex`,
    )
    assertAllowedModel(requestedModel)
    return await handleCodexImages(
      c,
      operation,
      undefined,
      parsed.createRequest(requestedModel),
    )
  }

  return await handleCodexImages(
    c,
    operation,
    undefined,
    parsed.createRequest(mappedModel),
  )
}
