import { Hono, type Context } from "hono"

import { forwardError } from "~/lib/error"
import { GITHUB_COPILOT_PROVIDER } from "~/lib/github-copilot-provider"
import { prepareImageJsonRequest } from "~/lib/image-json-request"
import { getDefaultImageModel } from "~/lib/image-models"
import { createHandlerLogger } from "~/lib/logger"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import {
  forwardCopilotImagesWithLogging,
  forwardProviderImagesWithLogging,
} from "~/routes/images/forward-provider-images"
import {
  imageEditRequestErrorResponse,
  withImageEditRequest,
} from "~/routes/images/multipart-edits"
import type { ParsedImagesRequest } from "~/routes/images/shared"
import type { CodexImagesOperation } from "~/services/codex/images"

const logger = createHandlerLogger("provider-images-handler")

export const providerImageRoutes = new Hono()

async function handleProviderImages(
  c: Context,
  operation: CodexImagesOperation,
): Promise<Response> {
  const provider = c.req.param("provider") ?? ""

  try {
    const providerConfig =
      provider === GITHUB_COPILOT_PROVIDER ? null : (
        await resolveProviderConfig(provider)
      )
    if (!providerConfig && provider !== GITHUB_COPILOT_PROVIDER) {
      return c.json(
        {
          error: {
            message: `Provider '${provider}' not found or disabled`,
            type: "invalid_request_error",
          },
        },
        404,
      )
    }

    const forward = async (
      request: Request,
      model?: string,
      multipartForm?: FormData,
    ) => {
      const context = { logger, provider, model, multipartForm }
      if (!providerConfig) {
        return await forwardCopilotImagesWithLogging(
          request,
          operation,
          context,
        )
      }
      return await forwardProviderImagesWithLogging(
        providerConfig,
        request,
        operation,
        context,
      )
    }

    const target = providerConfig?.name ?? provider
    const defaultModel = getDefaultImageModel(target)
    const isMultipartEdit =
      operation === "edits"
      && c.req.header("content-type")?.includes("multipart/form-data")
    if (!defaultModel && !isMultipartEdit) return await forward(c.req.raw)

    return await withImageEditRequest(c, operation, async (multipart) => {
      if (!defaultModel) {
        if (!multipart) return await forward(c.req.raw)
        const request = await multipart.createRequest(undefined, target)
        return await forward(request, multipart.model, multipart.formData)
      }
      const parsed: ParsedImagesRequest =
        multipart ?? (await prepareImageJsonRequest(c.req.raw))
      try {
        const requested = parsed.model?.trim()
        const alias = requested ? parseProviderModelAlias(requested) : null
        const model =
          (alias?.provider === target ? alias.model : requested) || defaultModel
        const request =
          parsed.model === model && parsed.originalRequest ?
            parsed.originalRequest
          : await parsed.createRequest(model, target)
        return await forward(request, model, multipart?.formData)
      } catch (error) {
        await parsed.originalRequest?.body?.cancel().catch(() => {})
        throw error
      }
    })
  } catch (error) {
    const invalidRequest = imageEditRequestErrorResponse(c, error)
    if (invalidRequest) return invalidRequest
    logger.error(`provider.images.${operation}.error`, { provider, error })
    return await forwardError(c, error)
  }
}

providerImageRoutes.post("/generations", (c) =>
  handleProviderImages(c, "generations"),
)
providerImageRoutes.post("/edits", (c) => handleProviderImages(c, "edits"))
