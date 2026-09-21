import { Hono } from "hono"

import { resolveMappedModel, type ResolvedProviderConfig } from "~/lib/config"
import { forwardError, HTTPError } from "~/lib/error"
import { assertAllowedModel } from "~/lib/model-admission"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import {
  createCopilotTokenUsageRecorder,
  createProviderTokenUsageRecorder,
} from "~/lib/token-usage"
import {
  createEmbeddings,
  type EmbeddingRequest,
  type EmbeddingResponse,
} from "~/services/copilot/create-embeddings"
import {
  createProviderProxyResponse,
  forwardProviderEmbeddings,
} from "~/services/providers/provider-proxy"

export const embeddingRouteDependencies = {
  createEmbeddings,
  forwardProviderEmbeddings,
  resolveMappedModel,
  resolveProviderConfig,
}

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    const payload = await c.req.json<EmbeddingRequest>()
    payload.model = embeddingRouteDependencies.resolveMappedModel(payload.model)
    assertAllowedModel(payload.model)

    const providerModelAlias = parseProviderModelAlias(payload.model)
    const providerConfig =
      providerModelAlias ?
        await embeddingRouteDependencies.resolveProviderConfig(
          providerModelAlias.provider,
        )
      : null
    if (providerModelAlias && providerConfig) {
      payload.model = providerModelAlias.model
      const upstreamResponse =
        await embeddingRouteDependencies.forwardProviderEmbeddings(
          providerConfig,
          payload,
          c.req.raw.headers,
          { clientSignal: c.req.raw.signal },
        )
      if (!upstreamResponse.ok) {
        throw new HTTPError(
          `Failed to create ${providerModelAlias.provider} embeddings`,
          upstreamResponse,
        )
      }

      const responseBody = (await upstreamResponse
        .clone()
        .json()) as EmbeddingResponse
      recordEmbeddingUsage(responseBody, payload.model, providerConfig)
      return createProviderProxyResponse(upstreamResponse)
    }

    const response = await embeddingRouteDependencies.createEmbeddings(payload)
    recordEmbeddingUsage(response, payload.model)
    return c.json(response)
  } catch (error) {
    return await forwardError(c, error)
  }
})

function recordEmbeddingUsage(
  response: EmbeddingResponse,
  model: string,
  providerConfig?: ResolvedProviderConfig,
): void {
  const recordUsage =
    providerConfig ?
      createProviderTokenUsageRecorder({
        endpoint: "embeddings",
        model,
        pricing: providerConfig.models?.[model]?.pricing,
        pricingCurrency: providerConfig.pricingCurrency,
        providerName: providerConfig.name,
      })
    : createCopilotTokenUsageRecorder({
        endpoint: "embeddings",
        model,
      })

  recordUsage({
    input_tokens: response.usage.prompt_tokens,
    output_tokens: 0,
  })
}
