import type { Context } from "hono"

import { toClaudeDiscoveryModelId } from "~/lib/catalog/claude-models"
import { stripInternalRequestHeaders } from "~/lib/http/internal-headers"
import {
  createModelListResponse,
  getAgentModels,
} from "~/routes/models/model-discovery"

export async function handleClaudeModels(c: Context): Promise<Response> {
  const models = await getAgentModels(
    stripInternalRequestHeaders(c.req.raw.headers),
  )
  return createModelListResponse(
    c,
    models.map((model) => ({
      ...model,
      id: toClaudeDiscoveryModelId(model.id),
      ...(typeof model.claude_model_id === "string" ?
        { claude_model_id: toClaudeDiscoveryModelId(model.claude_model_id) }
      : {}),
    })),
  )
}
