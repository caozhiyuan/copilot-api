import type { Context } from "hono"

import { stripInternalRequestHeaders } from "~/lib/internal-headers"
import {
  createModelListResponse,
  getAgentModels,
  getAggregatedModels,
} from "~/routes/models/model-discovery"

export async function handleDefaultModels(c: Context): Promise<Response> {
  const isDeepSeekClient =
    c.req.header("user-agent")?.toLowerCase().startsWith("deepseek") ?? false
  const getModels = isDeepSeekClient ? getAgentModels : getAggregatedModels
  const models = await getModels(
    stripInternalRequestHeaders(c.req.raw.headers),
    { includeImageModels: !isDeepSeekClient },
  )
  return createModelListResponse(c, models)
}
