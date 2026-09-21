import { Hono } from "hono"

import {
  BodySizeLimitExceededError,
  readBodyWithLimit,
} from "~/lib/bounded-body"
import { resolveMappedModel, type ResolvedProviderConfig } from "~/lib/config"
import {
  forwardError,
  HTTPError,
  UpstreamResponseSizeLimitExceededError,
} from "~/lib/error"
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

export const PROVIDER_EMBEDDINGS_RESPONSE_BYTE_LIMIT = 32 * 1024 * 1024

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
      let responseBytes: Uint8Array
      try {
        responseBytes = await readBodyWithLimit(
          upstreamResponse.body,
          PROVIDER_EMBEDDINGS_RESPONSE_BYTE_LIMIT,
          upstreamResponse.headers.get("content-length"),
        )
      } catch (error) {
        if (error instanceof BodySizeLimitExceededError) {
          throw new UpstreamResponseSizeLimitExceededError(error.maxBytes)
        }
        throw error
      }

      const bufferedUpstreamResponse = new Response(responseBytes, {
        headers: upstreamResponse.headers,
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
      })
      if (!bufferedUpstreamResponse.ok) {
        throw new HTTPError(
          `Failed to create ${providerModelAlias.provider} embeddings`,
          bufferedUpstreamResponse,
        )
      }

      const responseText = new TextDecoder().decode(responseBytes)
      const responseBody = JSON.parse(responseText) as EmbeddingResponse
      recordEmbeddingUsage(responseBody, payload.model, providerConfig)
      return createProviderProxyResponse(bufferedUpstreamResponse)
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
