import type { Context } from "hono"

import { forwardError } from "~/lib/error"
import { prepareImageJsonRequest } from "~/lib/image-json-request"
import { forwardXaiImagesWithLogging } from "~/routes/images/forward-provider-images"
import {
  imageEditRequestErrorResponse,
  withImageEditRequest,
} from "~/routes/images/multipart-edits"
import {
  imageRouteDependencies,
  logger,
  routeImagesRequest,
} from "~/routes/images/shared"
import { translateXaiImageJsonRequest } from "~/routes/images/xai-json-request"
import type { CodexImagesOperation } from "~/services/codex/images"
import { translateXaiImageEditJson } from "~/services/xai/images"

export async function handleImages(
  c: Context,
  operation: CodexImagesOperation,
): Promise<Response> {
  try {
    const configuredModel =
      operation === "edits" ?
        imageRouteDependencies.getImageEditModel()
      : imageRouteDependencies.getImageGenerationModel()
    if (configuredModel.status === "invalid") {
      return c.json(
        {
          error: {
            message: configuredModel.message,
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    return await withImageEditRequest(c, operation, async (multipart) => {
      if (configuredModel.status === "xai") {
        return await handleConfiguredXaiImages(
          c,
          operation,
          configuredModel.model,
          await multipart?.readPayload(),
        )
      }

      const parsed = multipart ?? (await prepareImageJsonRequest(c.req.raw))
      return await routeImagesRequest(c, operation, parsed)
    })
  } catch (error) {
    const invalidRequest = imageEditRequestErrorResponse(c, error)
    if (invalidRequest) return invalidRequest

    logger.error(`images.${operation}.error`, { error })
    return await forwardError(c, error)
  }
}

async function handleConfiguredXaiImages(
  c: Context,
  operation: CodexImagesOperation,
  model: string,
  multipartPayload?: Record<string, unknown>,
): Promise<Response> {
  const { payload, body } =
    multipartPayload ?
      {
        payload: translateXaiImageEditJson(multipartPayload, model),
        body: undefined,
      }
    : await translateXaiImageJsonRequest(c.req.raw, operation, model)
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
