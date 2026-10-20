import type { Context } from "hono"

import { forwardError } from "~/lib/error"
import {
  handleCodexImages,
  imageRouteDependencies,
  logger,
  parseJsonImagesRequest,
  routeImagesRequest,
} from "~/routes/images/shared"
import {
  handleXaiImageGeneration,
  xaiImagesRequestErrorResponse,
} from "~/routes/images/xai-handler"

export async function handleImagesGenerations(c: Context): Promise<Response> {
  try {
    const configuredModel = imageRouteDependencies.getImageGenerationModel()
    if (configuredModel.status === "invalid") {
      return c.json(
        {
          error: {
            message: configuredModel.message,
            type: "invalid_request_error",
          },
        },
        400,
      )
    }
    if (configuredModel.status === "xai") {
      return await handleXaiImageGeneration(c, configuredModel.model)
    }

    const parsed = await parseJsonImagesRequest(c.req.raw)
    if (parsed instanceof Request) {
      return await handleCodexImages(c, "generations", undefined, parsed)
    }

    return await routeImagesRequest(c, "generations", parsed)
  } catch (error) {
    const invalidRequest = xaiImagesRequestErrorResponse(c, error)
    if (invalidRequest) return invalidRequest

    logger.error("images.generations.error", { error })
    return await forwardError(c, error)
  }
}
