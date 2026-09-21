import { Hono, type Context } from "hono"

import { forwardError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { isAllowedModel, modelNotAllowedResponse } from "~/lib/model-admission"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import {
  createStagedFormDataRequest,
  parseEditsRequest,
  type StagedEditsRequest,
} from "~/routes/images/edits-handler"
import { parseGenerationsRequest } from "~/routes/images/generations-handler"
import { handleCodexImages } from "~/routes/images/route"
import type { CodexImagesOperation } from "~/services/codex/images"
import { forwardProviderImagesWithLogging } from "~/routes/images/forward-provider-images"

const logger = createHandlerLogger("provider-images-handler")

export const providerImageRoutes = new Hono()

async function handleProviderImages(
  c: Context,
  operation: CodexImagesOperation,
): Promise<Response> {
  const provider = c.req.param("provider") ?? ""

  try {
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

    let request: Request
    let stagedEdits: StagedEditsRequest | undefined

    if (operation === "generations") {
      const parsed = await parseGenerationsRequest(c.req.raw)
      if (parsed instanceof Request) {
        return modelNotAllowedResponse(c)
      }
      if (!isAllowedModel(parsed.model)) {
        return modelNotAllowedResponse(c)
      }
      request = parsed.originalRequest ?? parsed.createRequest(parsed.model)
    } else {
      const parsed = await parseEditsRequest(c.req.raw)
      if (parsed instanceof Request || parsed.model === undefined) {
        if (!(parsed instanceof Request)) await parsed.staged.cleanup()
        return modelNotAllowedResponse(c)
      }
      stagedEdits = parsed
      if (!isAllowedModel(parsed.model)) {
        await parsed.staged.cleanup()
        return modelNotAllowedResponse(c)
      }
      request = createStagedFormDataRequest(
        c.req.raw,
        parsed.requestHeaders,
        parsed.staged.formData,
      )
    }

    try {
      const response =
        providerConfig.name === "codex" ?
          await handleCodexImages(c, operation, providerConfig, request)
        : await forwardProviderImagesWithLogging(
            providerConfig,
            request,
            operation,
            { logger, provider },
          )
      stagedEdits?.staged.scheduleCleanup()
      return response
    } catch (error) {
      await stagedEdits?.staged.cleanup()
      throw error
    }
  } catch (error) {
    logger.error(`provider.images.${operation}.error`, { provider, error })
    return await forwardError(c, error)
  }
}

providerImageRoutes.post("/generations", (c) =>
  handleProviderImages(c, "generations"),
)
providerImageRoutes.post("/edits", (c) => handleProviderImages(c, "edits"))
