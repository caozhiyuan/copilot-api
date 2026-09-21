import type { Context } from "hono"

import { forwardError } from "~/lib/error"
import {
  imageEditsRouteDependencies,
  withParsedImagesRequest,
} from "~/routes/images/parsed-request"
import {
  handleCodexImages,
  logger,
  routeImagesRequest,
} from "~/routes/images/shared"
import {
  InvalidMultipartBodyError,
  MultipartBodyTooLargeError,
} from "~/routes/images/temp-form-data"

export { imageEditsRouteDependencies }

export async function handleImagesEdits(c: Context): Promise<Response> {
  try {
    return await withParsedImagesRequest(c.req.raw, "edits", async (parsed) => {
      if (parsed instanceof Request) {
        return await handleCodexImages(c, "edits", undefined, parsed)
      }
      return await routeImagesRequest(c, "edits", parsed)
    })
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

    logger.error("images.edits.error", { error })
    return await forwardError(c, error)
  }
}
