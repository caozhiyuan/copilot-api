import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { requestTimingsMiddleware } from "~/lib/request-timings"
import type { ResponsesPayload } from "~/lib/types/responses"
import { zstdDecompressionMiddleware } from "~/lib/zstd-request"

import { handleProviderResponsesForProvider } from "./handler"

export const providerResponsesRoutes = new Hono()

providerResponsesRoutes.use(zstdDecompressionMiddleware)
// After decompression, so the logged model is the one the handler sees.
providerResponsesRoutes.use(
  requestTimingsMiddleware({ includeResponses: true }),
)

providerResponsesRoutes.post("/", async (c) => {
  try {
    const provider = c.req.param("provider") ?? ""
    const payload = await c.req.json<ResponsesPayload>()
    return await handleProviderResponsesForProvider(c, { payload, provider })
  } catch (error) {
    return await forwardError(c, error)
  }
})
