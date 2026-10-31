import { Hono, type Context } from "hono"

import { resolveMappedModel } from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { recordVideoResultUsage } from "~/lib/token-usage/videos"
import { createProviderProxyResponse } from "~/services/providers/provider-proxy"
import {
  forwardXaiVideos,
  type XaiVideoRequest,
  XaiVideosRequestError,
} from "~/services/xai/videos"

const logger = createHandlerLogger("videos-handler")
const SUPPORTED_VIDEO_MODEL = "grok-imagine-video-1.5"

export const videoRouteDependencies = {
  debugJson,
  resolveMappedModel,
  resolveProviderConfig,
}

export const videoRoutes = new Hono()

async function parseGenerationRequest(
  request: Request,
): Promise<XaiVideoRequest> {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    throw new XaiVideosRequestError("Video generation body must be JSON")
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new XaiVideosRequestError(
      "Video generation body must be a JSON object",
    )
  }
  if (
    !("model" in payload)
    || typeof payload.model !== "string"
    || !payload.model.trim()
  ) {
    throw new XaiVideosRequestError("model is required and must be a string")
  }

  const mappedModel = videoRouteDependencies.resolveMappedModel(payload.model)
  const alias = parseProviderModelAlias(mappedModel)
  if (
    alias?.provider.toLowerCase() !== "xai"
    || alias.model !== SUPPORTED_VIDEO_MODEL
  ) {
    throw new XaiVideosRequestError(
      `Video generation only supports xai/${SUPPORTED_VIDEO_MODEL}`,
    )
  }

  return {
    operation: "generations",
    payload: { ...payload, model: alias.model },
  }
}

async function handleVideos(
  c: Context,
  operation: XaiVideoRequest["operation"],
): Promise<Response> {
  try {
    c.req.raw.signal.throwIfAborted()
    const videoRequest: XaiVideoRequest =
      operation === "generations" ?
        await parseGenerationRequest(c.req.raw)
      : { operation: "result", requestId: c.req.param("request_id") ?? "" }
    const providerConfig =
      await videoRouteDependencies.resolveProviderConfig("xai")
    if (!providerConfig) {
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

    const upstreamResponse = await forwardXaiVideos(
      providerConfig,
      c.req.raw,
      videoRequest,
    )
    debugJson(logger, `videos.${operation}.response`, {
      statusCode: upstreamResponse.status,
    })
    if (videoRequest.operation === "result") {
      await recordVideoResultUsage(upstreamResponse, {
        providerConfig,
        requestId: videoRequest.requestId,
        defaultModel: SUPPORTED_VIDEO_MODEL,
        onBody: (body) =>
          videoRouteDependencies.debugJson(
            logger,
            "videos.result.response.body",
            { body },
          ),
      })
    }
    return createProviderProxyResponse(upstreamResponse)
  } catch (error) {
    if (error instanceof XaiVideosRequestError && !c.req.raw.signal.aborted) {
      return c.json(
        { error: { message: error.message, type: "invalid_request_error" } },
        400,
      )
    }
    logger.error(`videos.${operation}.error`, { error })
    return await forwardError(c, error)
  }
}

videoRoutes.post("/generations", (c) => handleVideos(c, "generations"))
videoRoutes.get("/:request_id", (c) => handleVideos(c, "result"))
