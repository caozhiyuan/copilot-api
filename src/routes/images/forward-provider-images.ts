import type { ConsolaInstance } from "consola"

import { getRawProviderConfig, type ResolvedProviderConfig } from "~/lib/config"
import { GITHUB_COPILOT_PROVIDER } from "~/lib/github-copilot-provider"
import { debugJson, debugJsonAsync } from "~/lib/logger"
import { prepareImageJsonRequest } from "~/lib/image-json-request"
import { observeImagesResponse } from "~/lib/token-usage/images"
import { logImageEditRequest } from "~/routes/images/request-logging"
import {
  forwardCodexImages,
  type CodexImagesOperation,
} from "~/services/codex/images"
import { forwardCopilotImages } from "~/services/copilot/images"
import { forwardProviderImages } from "~/services/providers/provider-proxy"
import { ensureImageResponseB64Json } from "~/services/xai/images"

export const imageForwardDependencies = { debugJsonAsync }

export interface ProviderImagesForwardLogContext {
  logger: ConsolaInstance
  provider: string
  model?: string
  multipartForm?: FormData
}

/**
 * Forwards an images request to a configured provider with debug logging.
 * Shared by the top-level images routes (model mapping) and the
 * provider-scoped images routes so both log and proxy identically.
 */
export async function forwardProviderImagesWithLogging(
  providerConfig: ResolvedProviderConfig,
  request: Request,
  operation: CodexImagesOperation,
  { logger, provider, model, multipartForm }: ProviderImagesForwardLogContext,
): Promise<Response> {
  let actualModel = model
  if (
    actualModel === undefined
    && !request.headers.get("content-type")?.includes("multipart/form-data")
  ) {
    const parsed = await prepareImageJsonRequest(request)
    actualModel = parsed.model
    request = parsed.originalRequest
  }
  actualModel ??= "unknown"
  const isCodex = providerConfig.name === "codex"
  const label =
    isCodex ? `images.${operation}.codex` : `provider.images.${operation}`
  const extra = isCodex ? {} : { provider }
  try {
    request = await logImageEditRequest(
      logger,
      `${label}.request`,
      request,
      extra,
      imageForwardDependencies.debugJsonAsync,
      multipartForm,
    )
    const upstreamResponse =
      isCodex ? await forwardCodexImages(request, operation)
      : providerConfig.name === GITHUB_COPILOT_PROVIDER ?
        await forwardCopilotImages(request, operation)
      : await forwardProviderImages(providerConfig, request, operation)
    debugJson(logger, `${label}.response`, {
      contentType: upstreamResponse.headers.get("content-type"),
      contentLength: upstreamResponse.headers.get("content-length"),
      ...extra,
      statusCode: upstreamResponse.status,
    })
    return observeImagesResponse(upstreamResponse, {
      model: actualModel,
      operation,
      providerConfig,
      onMetadata: (metadata) =>
        debugJson(logger, `${label}.response.body`, { ...extra, ...metadata }),
    })
  } catch (error) {
    await request.body?.cancel().catch(() => {})
    throw error
  }
}

export async function forwardCopilotImagesWithLogging(
  request: Request,
  operation: CodexImagesOperation,
  context: ProviderImagesForwardLogContext,
): Promise<Response> {
  const config = getRawProviderConfig(GITHUB_COPILOT_PROVIDER)
  return await forwardProviderImagesWithLogging(
    {
      name: GITHUB_COPILOT_PROVIDER,
      type: "openai-compatible",
      authType: "oauth2",
      apiKey: "",
      baseUrl: "",
      models: config?.models,
      pricingCurrency: config?.pricingCurrency,
    },
    request,
    operation,
    context,
  )
}

/** Forwards translated xAI requests and normalizes OpenAI-compatible output. */
export async function forwardXaiImagesWithLogging(
  providerConfig: ResolvedProviderConfig,
  request: Request,
  operation: CodexImagesOperation,
  payload: Record<string, unknown>,
  { logger, provider, multipartForm }: ProviderImagesForwardLogContext,
  body: ReadableStream<Uint8Array>,
): Promise<Response> {
  const upstreamRequest = new Request(request.url, {
    body,
    duplex: "half",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
    signal: request.signal,
  } as RequestInit)
  const upstreamResponse = await forwardProviderImagesWithLogging(
    providerConfig,
    upstreamRequest,
    operation,
    {
      logger,
      provider,
      model: typeof payload.model === "string" ? payload.model : "unknown",
      multipartForm,
    },
  )
  return await ensureImageResponseB64Json(upstreamResponse, undefined, {
    clientSignal: request.signal,
    onImageUrl: (url) => {
      logger.info("images.xai.output.url", JSON.stringify({ operation, url }))
    },
    responseFormat: payload.response_format === "url" ? "url" : "b64_json",
  })
}
