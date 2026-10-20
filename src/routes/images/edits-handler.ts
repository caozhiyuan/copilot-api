import type { Context } from "hono"

import { forwardError } from "~/lib/error"
import {
  handleCodexImages,
  imageEditContentTypeErrorResponse,
  imageRouteDependencies,
  logger,
  parseJsonImagesRequest,
  routeImagesRequest,
} from "~/routes/images/shared"
import {
  handleXaiImageEdit,
  xaiImagesRequestErrorResponse,
} from "~/routes/images/xai-handler"

export async function handleImagesEdits(c: Context): Promise<Response> {
  try {
    const configuredModel = imageRouteDependencies.getImageEditModel()
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

    const contentTypeError = imageEditContentTypeErrorResponse(c)
    if (contentTypeError) return contentTypeError

    if (configuredModel.status === "xai") {
      return await handleXaiImageEdit(c, configuredModel.model)
    }

    const parsed = await parseJsonImagesRequest(c.req.raw)
    if (parsed instanceof Request) {
      return await handleCodexImages(c, "edits", undefined, parsed)
    }
    return await routeImagesRequest(c, "edits", parsed)
  } catch (error) {
    const invalidRequest = xaiImagesRequestErrorResponse(c, error)
    if (invalidRequest) return invalidRequest

    logger.error("images.edits.error", { error })
    return await forwardError(c, error)
  }
}
