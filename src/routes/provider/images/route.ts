import type { Context } from "hono"
import type { ProviderImageEndpoint } from "~/lib/config"

import { Hono } from "hono"

import { createHandlerLogger } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import {
  createProviderProxyResponse,
  forwardProviderImageRequest,
} from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("provider-images-handler")

export const providerImageRoutes = new Hono()

providerImageRoutes.post("/generations", async (c) => {
  return await handleProviderImageRequest(c, "generations")
})

providerImageRoutes.post("/edits", async (c) => {
  return await handleProviderImageRequest(c, "edits")
})

const handleProviderImageRequest = async (
  c: Context,
  endpoint: ProviderImageEndpoint,
): Promise<Response> => {
  const provider = c.req.param("provider") ?? ""
  if (provider === "codex") {
    return createUnsupportedProviderResponse(c, provider, endpoint)
  }

  try {
    const providerConfig = await resolveProviderConfig(provider)
    if (!providerConfig) {
      return c.json(
        {
          error: {
            message: `Provider '${provider}' not found or disabled`,
            type: "invalid_request_error",
          },
        },
        404,
      )
    }

    if (providerConfig.authType === "oauth2") {
      return createUnsupportedProviderResponse(c, provider, endpoint)
    }

    if (!providerConfig.imageEndpoints?.includes(endpoint)) {
      return createUnsupportedProviderResponse(c, provider, endpoint)
    }

    const upstreamResponse = await forwardProviderImageRequest(
      providerConfig,
      endpoint,
      c.req.raw,
    )

    logger.debug("provider.images.response", {
      endpoint,
      provider,
      statusCode: upstreamResponse.status,
    })
    return createProviderProxyResponse(upstreamResponse)
  } catch (error) {
    logger.error("provider.images.error", {
      endpoint,
      errorType: error instanceof Error ? error.name : "unknown",
      provider,
    })
    return c.json(
      {
        error: {
          message: "Failed to reach the image provider",
          type: "api_error",
        },
      },
      502,
    )
  }
}

const createUnsupportedProviderResponse = (
  c: Context,
  provider: string,
  endpoint: ProviderImageEndpoint,
): Response =>
  c.json(
    {
      error: {
        message: `Provider '${provider}' does not enable /v1/images/${endpoint}`,
        type: "invalid_request_error",
      },
    },
    400,
  )
