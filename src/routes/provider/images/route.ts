import { Hono, type Context } from "hono"

import { forwardError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { assertAllowedModel, ModelNotAllowedError } from "~/lib/model-admission"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { forwardProviderImagesWithLogging } from "~/routes/images/forward-provider-images"
import { withParsedImagesRequest } from "~/routes/images/parsed-request"
import { handleCodexImages } from "~/routes/images/shared"
import {
  InvalidMultipartBodyError,
  MultipartBodyTooLargeError,
} from "~/routes/images/temp-form-data"
import type { CodexImagesOperation } from "~/services/codex/images"

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

    return await withParsedImagesRequest(
      c.req.raw,
      operation,
      async (parsed) => {
        if (parsed instanceof Request) {
          throw new ModelNotAllowedError()
        }
        assertAllowedModel(parsed.model)

        const request = parsed.createRequest(parsed.model)
        if (providerConfig.name === "codex") {
          return await handleCodexImages(c, operation, providerConfig, request)
        }
        return await forwardProviderImagesWithLogging(
          providerConfig,
          request,
          operation,
          { logger, provider },
        )
      },
    )
  } catch (error) {
    if (
      error instanceof InvalidMultipartBodyError
      || error instanceof MultipartBodyTooLargeError
    ) {
      return c.json(
        {
          error: {
            message: error.message,
            type: "invalid_request_error",
          },
        },
        error instanceof MultipartBodyTooLargeError ? 413 : 400,
      )
    }

    logger.error(`provider.images.${operation}.error`, { provider, error })
    return await forwardError(c, error)
  }
}

providerImageRoutes.post("/generations", (c) =>
  handleProviderImages(c, "generations"),
)
providerImageRoutes.post("/edits", (c) => handleProviderImages(c, "edits"))
