import { Hono, type Context } from "hono"

import { getImageModel, type ResolvedProviderConfig } from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger, debugJson, debugJsonAsync } from "~/lib/logger"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import {
  forwardCodexImages,
  type CodexImagesOperation,
} from "~/services/codex/images"
import {
  createProviderProxyResponse,
  forwardProviderImages,
} from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("images-handler")

export const imageRoutes = new Hono()
export const imageRouteDependencies = { debugJsonAsync }

function getContentMetadata(headers: Headers) {
  return {
    contentType: headers.get("content-type"),
    contentLength: headers.get("content-length"),
  }
}

/**
 * Handles Codex images proxying. Pass `resolvedProviderConfig` when the
 * caller already resolved the codex provider to avoid a second resolve.
 */
export async function handleCodexImages(
  c: Context,
  operation: CodexImagesOperation,
  resolvedProviderConfig?: ResolvedProviderConfig,
): Promise<Response> {
  try {
    const codexProviderConfig =
      resolvedProviderConfig ?? (await resolveProviderConfig("codex"))
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
          body: await c.req.raw.clone().text(),
        }),
      )
    } else {
      debugJson(
        logger,
        "images.edits.codex.request",
        getContentMetadata(c.req.raw.headers),
      )
    }

    const upstreamResponse = await forwardCodexImages(c.req.raw, operation)
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

async function createImageRequest(
  request: Request,
  operation: CodexImagesOperation,
  model: string,
): Promise<Request> {
  const headers = new Headers(request.headers)
  headers.delete("content-length")
  let body: unknown

  if (operation === "generations") {
    const payload = (await request.json()) as Record<string, unknown>
    headers.set("content-type", "application/json")
    body = JSON.stringify({ ...payload, model })
  } else {
    const formData = await request.formData()
    formData.set("model", model)
    headers.delete("content-type")
    body = formData
  }

  return new Request(request.url, {
    body: body as never,
    headers,
    method: request.method,
  })
}

async function handleImages(
  c: Context,
  operation: CodexImagesOperation,
): Promise<Response> {
  const configuredImageModel = getImageModel()
  if (!configuredImageModel) {
    return await handleCodexImages(c, operation)
  }

  try {
    const providerModelAlias = parseProviderModelAlias(configuredImageModel)
    if (!providerModelAlias) {
      throw new Error("imageModel must use the provider/model format")
    }

    const providerConfig = await resolveProviderConfig(
      providerModelAlias.provider,
    )
    if (!providerConfig || providerConfig.name === "codex") {
      throw new Error(
        `Image provider '${providerModelAlias.provider}' not found, disabled, or unsupported`,
      )
    }

    const upstreamResponse = await forwardProviderImages(
      providerConfig,
      await createImageRequest(c.req.raw, operation, providerModelAlias.model),
      operation,
    )
    return createProviderProxyResponse(upstreamResponse)
  } catch (error) {
    logger.error(`images.${operation}.provider.error`, {
      error,
      imageModel: configuredImageModel,
    })
    return await forwardError(c, error)
  }
}

imageRoutes.post("/generations", (c) => handleImages(c, "generations"))
imageRoutes.post("/edits", (c) => handleImages(c, "edits"))
