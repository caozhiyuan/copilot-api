import { Hono, type Context } from "hono"

import { forwardError } from "~/lib/error"
import { GITHUB_COPILOT_PROVIDER } from "~/lib/github-copilot-provider"
import { prepareImageJsonRequest } from "~/lib/image-json-request"
import { getDefaultImageModel } from "~/lib/image-models"
import { createHandlerLogger } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { resolveImageRequestModel } from "~/routes/images/default-model"
import {
  forwardCopilotImagesWithLogging,
  forwardProviderImagesWithLogging,
} from "~/routes/images/forward-provider-images"
import {
  imageEditRequestErrorResponse,
  withImageEditRequest,
} from "~/routes/images/multipart-edits"
import {
  handleCodexImages,
  type ParsedImagesRequest,
} from "~/routes/images/shared"
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

    const forward = async (request: Request, model?: string) => {
      const context = { logger, provider, model }
      if (!providerConfig) {
        return await forwardCopilotImagesWithLogging(
          request,
          operation,
          context,
        )
      }
      if (providerConfig.name === "codex") {
        return await handleCodexImages(
          c,
          operation,
          providerConfig,
          request,
          model,
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
    if (!getDefaultImageModel(target)) return await forward(c.req.raw)

    return await withImageEditRequest(c, operation, async (multipart) => {
      const parsed: ParsedImagesRequest =
        multipart ?? (await prepareImageJsonRequest(c.req.raw))
      try {
        const model = await resolveImageRequestModel(parsed.model, {
          provider: target,
        })
        const request =
          parsed.model === model && parsed.originalRequest ?
            parsed.originalRequest
          : await parsed.createRequest(model, target)
        return await forward(request, model)
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
