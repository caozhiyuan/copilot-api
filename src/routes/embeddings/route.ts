import { Hono } from "hono"

import { resolveMappedModel } from "~/lib/config"
import { forwardError } from "~/lib/error"
import { assertAllowedModel } from "~/lib/model-admission"
import { createCopilotTokenUsageRecorder } from "~/lib/token-usage"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    const paylod = await c.req.json<EmbeddingRequest>()
    paylod.model = resolveMappedModel(paylod.model)
    assertAllowedModel(paylod.model)
    const response = await createEmbeddings(paylod)
    const recordUsage = createCopilotTokenUsageRecorder({
      endpoint: "embeddings",
      model: paylod.model,
    })

    recordUsage({
      input_tokens: response.usage.prompt_tokens,
      output_tokens: 0,
    })

    return c.json(response)
  } catch (error) {
    return await forwardError(c, error)
  }
})
