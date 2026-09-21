import type { Context } from "hono"

import { forwardError } from "~/lib/error"
import { withParsedImagesRequest } from "~/routes/images/parsed-request"
import {
  handleCodexImages,
  logger,
  routeImagesRequest,
} from "~/routes/images/shared"

export async function handleImagesGenerations(c: Context): Promise<Response> {
  try {
    return await withParsedImagesRequest(
      c.req.raw,
      "generations",
      async (parsed) => {
        if (parsed instanceof Request) {
          return await handleCodexImages(c, "generations", undefined, parsed)
        }
        return await routeImagesRequest(c, "generations", parsed)
      },
    )
  } catch (error) {
    logger.error("images.generations.error", { error })
    return await forwardError(c, error)
  }
}
