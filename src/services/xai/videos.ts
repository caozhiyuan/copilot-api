import {
  getUpstreamTransportConfig,
  type ResolvedProviderConfig,
} from "~/lib/config"
import {
  buildProviderUpstreamHeaders,
  resolveProviderEndpointUrl,
} from "~/services/providers/provider-proxy"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"

export class XaiVideosRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "XaiVideosRequestError"
  }
}

export type XaiVideoRequest =
  | {
      operation: "generations"
      payload: Record<string, unknown> & { model: string }
    }
  | { operation: "result"; requestId: string; signal?: AbortSignal }

function encodeRequestId(requestId: string): string {
  if (
    !requestId.trim()
    || requestId === "."
    || requestId === ".."
    || /[/\\]/u.test(requestId)
  ) {
    throw new XaiVideosRequestError("request_id must be a single path segment")
  }
  return encodeURIComponent(requestId)
}

/** Submits or queries a native xAI video job without polling or retrying. */
export async function forwardXaiVideos(
  providerConfig: ResolvedProviderConfig,
  request: Request,
  videoRequest: XaiVideoRequest,
): Promise<Response> {
  const endpoint =
    videoRequest.operation === "generations" ?
      "videos/generations"
    : `videos/${encodeRequestId(videoRequest.requestId)}`
  const upstreamUrl = new URL(
    resolveProviderEndpointUrl(providerConfig, endpoint),
  )
  upstreamUrl.search = new URL(request.url).search

  const headers = buildProviderUpstreamHeaders(providerConfig, request.headers)
  const transport = getUpstreamTransportConfig()

  return await fetchUpstreamWithLifecycle(
    upstreamUrl,
    {
      method: videoRequest.operation === "generations" ? "POST" : "GET",
      headers,
      body:
        videoRequest.operation === "generations" ?
          JSON.stringify(videoRequest.payload)
        : undefined,
      ...(videoRequest.operation === "result" && videoRequest.signal ?
        { signal: videoRequest.signal }
      : {}),
    },
    {
      clientSignal: request.signal,
      headersTimeoutMs: transport.headersTimeoutMs,
      streamInactivityTimeoutMs: transport.streamInactivityTimeoutMs,
    },
  )
}
