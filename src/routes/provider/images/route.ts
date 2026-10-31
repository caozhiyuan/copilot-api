import { Hono, type Context } from "hono"

import { forwardError } from "~/lib/error"
import { GITHUB_COPILOT_PROVIDER } from "~/lib/github-copilot-provider"
import { getDefaultImageModel } from "~/lib/image-models"
import { createHandlerLogger } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { handleCodexImages } from "~/routes/images/route"
import {
  imageEditRequestErrorResponse,
  parseMultipartImageEdit,
} from "~/routes/images/multipart-edits"
import {
  imageEditContentTypeErrorResponse,
  parseJsonImagesRequest,
} from "~/routes/images/shared"
import { type CodexImagesOperation } from "~/services/codex/images"
import {
  forwardCopilotImagesWithLogging,
  forwardProviderImagesWithLogging,
} from "~/routes/images/forward-provider-images"
import { resolveImageRequestModel } from "~/routes/images/default-model"

const logger = createHandlerLogger("provider-images-handler")

export const providerImageRoutes = new Hono()

async function handleProviderImages(
  c: Context,
  operation: CodexImagesOperation,
): Promise<Response> {
  const provider = c.req.param("provider") ?? ""

  try {
    if (provider === GITHUB_COPILOT_PROVIDER) {
      return await handleCopilotImages(c, operation)
    }
    const providerConfig = await resolveProviderConfig(provider)
    if (!providerConfig) {
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

    if (
      operation === "edits"
      && (providerConfig.name === "codex" || providerConfig.name === "xai")
    ) {
      const contentTypeError = imageEditContentTypeErrorResponse(c)
      if (contentTypeError) return contentTypeError
      const multipart = await parseMultipartImageEdit(c.req.raw)
      if (multipart) {
        try {
          const model = await resolveImageRequestModel(multipart.model, {
            provider: providerConfig.name,
          })
          const request = await multipart.createRequest(
            model,
            providerConfig.name,
          )
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
            { logger, provider, model },
          )
        } finally {
          await multipart.cleanup()
        }
      }
    }
    if (getDefaultImageModel(providerConfig.name)) {
      const { request, model } = await prepareProviderJsonImages(
        c.req.raw,
        providerConfig.name,
      )
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
        { logger, provider, model },
      )
    }

    return await forwardProviderImagesWithLogging(
      providerConfig,
      c.req.raw,
      operation,
      { logger, provider },
    )
  } catch (error) {
    const invalidRequest = imageEditRequestErrorResponse(c, error)
    if (invalidRequest) return invalidRequest
    logger.error(`provider.images.${operation}.error`, { provider, error })
    return await forwardError(c, error)
  }
}

async function handleCopilotImages(
  c: Context,
  operation: CodexImagesOperation,
): Promise<Response> {
  if (operation === "edits") {
    const contentTypeError = imageEditContentTypeErrorResponse(c)
    if (contentTypeError) return contentTypeError
    const multipart = await parseMultipartImageEdit(c.req.raw)
    if (multipart) {
      try {
        const model = await resolveImageRequestModel(multipart.model, {
          provider: GITHUB_COPILOT_PROVIDER,
        })
        return await forwardCopilotImagesWithLogging(
          await multipart.createRequest(model, GITHUB_COPILOT_PROVIDER),
          operation,
          { logger, provider: GITHUB_COPILOT_PROVIDER, model },
        )
      } finally {
        await multipart.cleanup()
      }
    }
  }
  const { request, model } = await prepareProviderJsonImages(
    c.req.raw,
    GITHUB_COPILOT_PROVIDER,
  )
  return await forwardCopilotImagesWithLogging(request, operation, {
    logger,
    provider: GITHUB_COPILOT_PROVIDER,
    model,
  })
}

async function prepareProviderJsonImages(request: Request, provider: string) {
  const parsed = await parseJsonImagesRequest(request)
  if (parsed instanceof Request) return { request: parsed, model: "unknown" }
  try {
    const model = await resolveImageRequestModel(parsed.model, {
      provider,
    })
    return {
      model,
      request:
        parsed.model === model && parsed.originalRequest ?
          parsed.originalRequest
        : await parsed.createRequest(model),
    }
  } catch (error) {
    await parsed.originalRequest?.body?.cancel().catch(() => {})
    throw error
  }
}

providerImageRoutes.post("/generations", (c) =>
  handleProviderImages(c, "generations"),
)
providerImageRoutes.post("/edits", (c) => handleProviderImages(c, "edits"))
