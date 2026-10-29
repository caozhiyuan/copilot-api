import { Hono, type Context } from "hono"

import { forwardError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { handleCodexImages } from "~/routes/images/route"
import {
  imageEditRequestErrorResponse,
  parseMultipartImageEdit,
} from "~/routes/images/multipart-edits"
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

    if (
      operation === "edits"
      && (providerConfig.name === "codex" || providerConfig.name === "xai")
    ) {
      const contentTypeError = imageEditContentTypeErrorResponse(c)
      if (contentTypeError) return contentTypeError
      const multipart = await parseMultipartImageEdit(c.req.raw)
      if (multipart) {
        try {
          const request = await multipart.createRequest(
            multipart.model,
            providerConfig.name,
          )
          if (providerConfig.name === "codex") {
            return await handleCodexImages(
              c,
              operation,
              providerConfig,
              request,
            )
          }
          return await forwardProviderImagesWithLogging(
            providerConfig,
            request,
            operation,
            { logger, provider },
          )
        } finally {
          await multipart.cleanup()
        }
      }
    }
    if (providerConfig.name === "codex") {
      return await handleCodexImages(c, operation, providerConfig)
    }

    return await forwardProviderImagesWithLogging(
      providerConfig,
      c.req.raw,
      operation,
      { logger, provider },
    )
  } catch (error) {
    const invalidRequest = imageEditRequestErrorResponse(c, error)
    if (invalidRequest) return invalidRequest
    logger.error(`provider.images.${operation}.error`, { provider, error })
    return await forwardError(c, error)
  }
}

providerImageRoutes.post("/generations", (c) =>
  handleProviderImages(c, "generations"),
)
providerImageRoutes.post("/edits", (c) => handleProviderImages(c, "edits"))
