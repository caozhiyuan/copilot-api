import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { filterAllowedModels } from "~/lib/model-admission"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import {
  handleCodexModelsProxy,
  isCodexUserAgent,
} from "~/routes/models/codex-models"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import {
  createProviderProxyResponse,
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
        data: filterAllowedModels(models.data, (model) => model.id),
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

    if (!upstreamResponse.ok) {
      return createProviderProxyResponse(upstreamResponse)
    }

    const body: unknown = await upstreamResponse.json()
    if (!isProviderModelsResponse(body)) {
      return c.json(
        {
          error: {
            message: `Provider '${provider}' returned an invalid models catalog`,
            type: "upstream_error",
          },
        },
        502,
      )
    }

    const filteredResponse = new Response(
      JSON.stringify({
        ...body,
        data: filterAllowedModels(body.data, (model) => model.id),
      }),
      {
        headers: upstreamResponse.headers,
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
      },
    )
    return createProviderProxyResponse(filteredResponse)
  } catch (error) {
    logger.error("provider.models.error", {
      provider,
      error,
    })
    return await forwardError(c, error)
  }
})

function isProviderModelsResponse(
  value: unknown,
): value is { data: Array<Record<string, unknown>>; [key: string]: unknown } {
  return (
    typeof value === "object"
    && value !== null
    && Array.isArray((value as { data?: unknown }).data)
    && (value as { data: Array<unknown> }).data.every(
      (model) =>
        typeof model === "object"
        && model !== null
        && typeof (model as { id?: unknown }).id === "string",
    )
  )
}
