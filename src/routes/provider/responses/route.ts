import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { setPluginRequestModel } from "~/lib/request-events"
import type { ResponsesPayload } from "~/lib/types/responses"
import { zstdDecompressionMiddleware } from "~/lib/zstd-request"

import { handleProviderResponsesForProvider } from "./handler"

export const providerResponsesRoutes = new Hono()

providerResponsesRoutes.use(zstdDecompressionMiddleware)

providerResponsesRoutes.post("/", async (c) => {
  try {
    const provider = c.req.param("provider") ?? ""
    const payload = await c.req.json<ResponsesPayload>()
    setPluginRequestModel(payload.model)
    return await handleProviderResponsesForProvider(c, { payload, provider })
  } catch (error) {
    return await forwardError(c, error)
  }
})
