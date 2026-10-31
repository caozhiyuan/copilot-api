import type { Context } from "hono"

import { forwardXaiImagesWithLogging } from "~/routes/images/forward-provider-images"
import { imageRouteDependencies, logger } from "~/routes/images/shared"
import { translateXaiImageJsonRequest } from "~/routes/images/xai-json-request"
import type { CodexImagesOperation } from "~/services/codex/images"
import {
  translateXaiImageEditJson,
  XaiImagesRequestError,
} from "~/services/xai/images"

export function xaiImagesRequestErrorResponse(
  c: Context,
  error: unknown,
): Response | null {
  if (!(error instanceof XaiImagesRequestError)) return null

  return c.json(
    {
      error: {
        message: error.message,
        type: "invalid_request_error",
      },
    },
    400,
  )
}

async function forwardTranslatedXaiImages(
  c: Context,
  operation: CodexImagesOperation,
  payload: Record<string, unknown>,
  body?: ReadableStream<Uint8Array>,
): Promise<Response> {
  const providerConfig =
    await imageRouteDependencies.resolveProviderConfig("xai")
  if (!providerConfig) {
    await body?.cancel()
    return c.json(
      {
        error: {
          message: "Provider 'xai' not found or disabled",
          type: "invalid_request_error",
        },
      },
      404,
    )
  }

  return await forwardXaiImagesWithLogging(
    providerConfig,
    c.req.raw,
    operation,
    payload,
    { logger, provider: "xai" },
    body,
  )
}

export async function handleXaiImageGeneration(
  c: Context,
  model: string,
): Promise<Response> {
  const translated = await translateXaiImageJsonRequest(
    c.req.raw,
    "generations",
    model,
  )
  return await forwardTranslatedXaiImages(
    c,
    "generations",
    translated.payload,
    translated.body,
  )
}

export async function handleXaiImageEdit(
  c: Context,
  model: string,
  multipartPayload?: Record<string, unknown>,
): Promise<Response> {
  if (multipartPayload) {
    return await forwardTranslatedXaiImages(
      c,
      "edits",
      translateXaiImageEditJson(multipartPayload, model),
    )
  }
  const translated = await translateXaiImageJsonRequest(
    c.req.raw,
    "edits",
    model,
  )
  return await forwardTranslatedXaiImages(
    c,
    "edits",
    translated.payload,
    translated.body,
  )
}
