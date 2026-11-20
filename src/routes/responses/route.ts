import { Hono } from "hono"

import { forwardError } from "~/lib/http/error"
import { zstdDecompressionMiddleware } from "~/lib/http/zstd-request"

import { handleResponses } from "./handler"

export const responsesRoutes = new Hono()

responsesRoutes.use(zstdDecompressionMiddleware)

responsesRoutes.post("/", async (c) => {
  try {
    return await handleResponses(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
