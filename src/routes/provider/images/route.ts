import { Hono, type Context } from "hono"

import { forwardError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { handleCodexImages } from "~/routes/images/route"
import { imageEditContentTypeErrorResponse } from "~/routes/images/shared"
import type { CodexImagesOperation } from "~/services/codex/images"
import { forwardProviderImagesWithLogging } from "~/routes/images/forward-provider-images"

const logger = createHandlerLogger("provider-images-handler")

export const providerImageRoutes = new Hono()

async function handleProviderImages(
  c: Context,
  operation: CodexImagesOperation,
): Promise<Response> {
  const provider = c.req.param("provider") ?? ""

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

    if (providerConfig.name === "codex") {
      if (operation === "edits") {
        const contentTypeError = imageEditContentTypeErrorResponse(c)
        if (contentTypeError) return contentTypeError
      }
      return await handleCodexImages(c, operation, providerConfig)
    }

    return await forwardProviderImagesWithLogging(
      providerConfig,
      c.req.raw,
      operation,
      { logger, provider },
    )
  } catch (error) {
    logger.error(`provider.images.${operation}.error`, { provider, error })
    return await forwardError(c, error)
  }
}

providerImageRoutes.post("/generations", (c) =>
  handleProviderImages(c, "generations"),
)
providerImageRoutes.post("/edits", (c) => handleProviderImages(c, "edits"))
