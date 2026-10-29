import type { Context } from "hono"

import { forwardError } from "~/lib/error"
import {
  imageEditRequestErrorResponse,
  parseMultipartImageEdit,
} from "~/routes/images/multipart-edits"
import {
  handleCodexImages,
  imageEditContentTypeErrorResponse,
  imageRouteDependencies,
  logger,
  parseJsonImagesRequest,
  routeImagesRequest,
} from "~/routes/images/shared"
import { handleXaiImageEdit } from "~/routes/images/xai-handler"

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

    const multipart = await parseMultipartImageEdit(c.req.raw)
    if (multipart) {
      try {
        if (configuredModel.status === "xai") {
          return await handleXaiImageEdit(
            c,
            configuredModel.model,
            await multipart.readPayload(),
          )
        }
        if (multipart.model === undefined) {
          return await handleCodexImages(
            c,
            "edits",
            undefined,
            await multipart.createRequest(undefined),
          )
        }
        return await routeImagesRequest(c, "edits", {
          model: multipart.model,
          createRequest: (model, provider) =>
            multipart.createRequest(model, provider),
        })
      } catch (error) {
        await multipart.cleanup()
        throw error
      } finally {
        multipart.scheduleCleanup()
      }
    }

    if (configuredModel.status === "xai") {
      return await handleXaiImageEdit(c, configuredModel.model)
    }

    const parsed = await parseJsonImagesRequest(c.req.raw)
    if (parsed instanceof Request) {
      return await handleCodexImages(c, "edits", undefined, parsed)
    }
    return await routeImagesRequest(c, "edits", parsed)
  } catch (error) {
    const invalidRequest = imageEditRequestErrorResponse(c, error)
    if (invalidRequest) return invalidRequest

    logger.error("images.edits.error", { error })
    return await forwardError(c, error)
  }
}
