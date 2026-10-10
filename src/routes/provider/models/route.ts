import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { withModelDisplayName } from "~/lib/model-display-name"
import { getLocalProviderModelRecords } from "~/lib/provider-model-catalog"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import {
  handleCodexModelsProxy,
  isCodexUserAgent,
} from "~/routes/models/codex-models"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import {
  createProviderProxyResponse,
  createProviderProxyResponseHeaders,
  forwardProviderModels,
} from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("provider-models-handler")

export const providerModelRoutes = new Hono()

providerModelRoutes.get("/", async (c) => {
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

    if (providerConfig.name === "codex") {
      if (isCodexUserAgent(c.req.header("user-agent"))) {
        return await handleCodexModelsProxy(c, providerConfig)
      }

      const models = getCodexModels()
      return c.json({
        object: "list",
        data: models.data.map((model) =>
          withModelDisplayName(model, providerConfig.name),
        ),
        has_more: false,
      })
    }

    const localModels = getLocalProviderModelRecords(
      providerConfig.name,
      providerConfig,
    )
    if (localModels !== undefined) {
      if (localModels.length === 0) {
        return c.json(
          {
            error: {
              message: `${providerConfig.name} model catalog is unavailable`,
              type: "service_unavailable",
            },
          },
          503,
        )
      }
      return c.json({
        object: "list",
        data: localModels.map((model) =>
          withModelDisplayName(model, providerConfig.name),
        ),
        has_more: false,
      })
    }

    const upstreamResponse = await forwardProviderModels(
      providerConfig,
      c.req.raw.headers,
    )

    logger.debug("provider.models.response", {
      provider,
      statusCode: upstreamResponse.status,
    })

    if (upstreamResponse.ok) {
      const body: unknown = await upstreamResponse
        .clone()
        .json()
        .catch(() => null)
      if (
        typeof body === "object"
        && body !== null
        && "data" in body
        && Array.isArray(body.data)
      ) {
        const upstreamModels = body.data
        const data = upstreamModels.map((model: unknown) =>
          withModelDisplayName(model, providerConfig.name),
        )
        if (data.every((model, index) => model === upstreamModels[index])) {
          return createProviderProxyResponse(upstreamResponse)
        }
        const headers = createProviderProxyResponseHeaders(
          upstreamResponse.headers,
        )
        headers.delete("etag")
        return Response.json(
          { ...body, data },
          { status: upstreamResponse.status, headers },
        )
      }
    }
    return createProviderProxyResponse(upstreamResponse)
  } catch (error) {
    logger.error("provider.models.error", {
      provider,
      error,
    })
    return await forwardError(c, error)
  }
})
