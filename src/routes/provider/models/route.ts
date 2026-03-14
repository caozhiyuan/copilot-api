import { Hono } from "hono"

import { getProviderConfig } from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import {
  createProviderProxyResponse,
  forwardProviderModels,
} from "~/services/providers/anthropic-proxy"

const logger = createHandlerLogger("provider-models-handler")

export const providerModelRoutes = new Hono()

providerModelRoutes.get("/", async (c) => {
  const provider = c.req.param("provider") ?? ""

  try {
    const providerConfig = getProviderConfig(provider)
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

    const upstreamResponse = await forwardProviderModels(
      providerConfig,
      c.req.raw.headers,
    )

    logger.debug("provider.models.response", {
      provider,
      statusCode: upstreamResponse.status,
    })

    return createProviderProxyResponse(upstreamResponse)
  } catch (error) {
    logger.error("provider.models.error", {
      provider,
      error,
    })
    return await forwardError(c, error)
  }
})
