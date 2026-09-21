import { Hono } from "hono"

import {
  assertBodySizeWithinLimit,
  BodySizeLimitExceededError,
  readBodyWithLimit,
} from "~/lib/bounded-body"
import { resolveMappedModel, type ResolvedProviderConfig } from "~/lib/config"
import { streamEmbeddingResponseBody } from "~/lib/embedding-response-stream"
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
const PROVIDER_EMBEDDINGS_ERROR_RESPONSE_BYTE_LIMIT = 1024 * 1024

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
      assertProviderResponseWithinLimit(upstreamResponse)
      if (!upstreamResponse.ok) {
        const bufferedUpstreamResponse =
          await bufferProviderErrorResponse(upstreamResponse)
        throw new HTTPError(
          `Failed to create ${providerModelAlias.provider} embeddings`,
          bufferedUpstreamResponse,
        )
      }

      const recordUsage = createEmbeddingUsageRecorder(
        payload.model,
        providerConfig,
      )
      const responseBody = streamEmbeddingResponseBody(
        upstreamResponse.body,
        PROVIDER_EMBEDDINGS_RESPONSE_BYTE_LIMIT,
        (promptTokens) => {
          recordUsage({ input_tokens: promptTokens, output_tokens: 0 })
        },
      )
      return createProviderProxyResponse(upstreamResponse, responseBody)
    }

    const response = await embeddingRouteDependencies.createEmbeddings(payload)
    recordEmbeddingUsage(response, payload.model)
    return c.json(response)
  } catch (error) {
    return await forwardError(c, error)
  }
})

function assertProviderResponseWithinLimit(response: Response): void {
  try {
    assertBodySizeWithinLimit(
      response.body,
      PROVIDER_EMBEDDINGS_RESPONSE_BYTE_LIMIT,
      response.headers.get("content-length"),
    )
  } catch (error) {
    if (error instanceof BodySizeLimitExceededError) {
      throw new UpstreamResponseSizeLimitExceededError(error.maxBytes)
    }
    throw error
  }
}

async function bufferProviderErrorResponse(
  response: Response,
): Promise<Response> {
  try {
    const responseBytes = await readBodyWithLimit(
      response.body,
      PROVIDER_EMBEDDINGS_ERROR_RESPONSE_BYTE_LIMIT,
      response.headers.get("content-length"),
    )
    return new Response(responseBytes, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    })
  } catch (error) {
    if (error instanceof BodySizeLimitExceededError) {
      throw new UpstreamResponseSizeLimitExceededError(error.maxBytes)
    }
    throw error
  }
}

function createEmbeddingUsageRecorder(
  model: string,
  providerConfig?: ResolvedProviderConfig,
) {
  return providerConfig ?
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
}

function recordEmbeddingUsage(
  response: EmbeddingResponse,
  model: string,
  providerConfig?: ResolvedProviderConfig,
): void {
  const recordUsage = createEmbeddingUsageRecorder(model, providerConfig)
  recordUsage({ input_tokens: response.usage.prompt_tokens, output_tokens: 0 })
}
