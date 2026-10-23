import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { requestTimingsMiddleware } from "~/lib/request-timings"
import { zstdDecompressionMiddleware } from "~/lib/zstd-request"

import { handleResponses } from "./handler"

export const responsesRoutes = new Hono()

responsesRoutes.use(zstdDecompressionMiddleware)
// After decompression, so the logged model is the one the handler sees.
responsesRoutes.use(requestTimingsMiddleware({ includeResponses: true }))

responsesRoutes.post("/", async (c) => {
  try {
    return await handleResponses(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
