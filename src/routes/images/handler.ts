import type { Context } from "hono"

import { forwardError } from "~/lib/error"
import { prepareImageJsonRequest } from "~/lib/image-json-request"
import {
  imageEditRequestErrorResponse,
  withImageEditRequest,
} from "~/routes/images/multipart-edits"
import { logger, routeImagesRequest } from "~/routes/images/shared"
import type { CodexImagesOperation } from "~/services/codex/images"

export async function handleImages(
  c: Context,
  operation: CodexImagesOperation,
): Promise<Response> {
  try {
    return await withImageEditRequest(c, operation, async (multipart) => {
      const parsed = multipart ?? (await prepareImageJsonRequest(c.req.raw))
      return await routeImagesRequest(operation, parsed)
    })
  } catch (error) {
    const invalidRequest = imageEditRequestErrorResponse(c, error)
    if (invalidRequest) return invalidRequest

    logger.error(`images.${operation}.error`, { error })
    return await forwardError(c, error)
  }
}
