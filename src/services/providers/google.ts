import {
  getUpstreamTransportConfig,
  type ResolvedProviderConfig,
} from "~/lib/config"
import type { GoogleGenerateContentPayload } from "~/lib/types/google"
import { setPluginRequestActualModel } from "~/lib/request-context"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"

import {
  applyOpencodeSessionHeader,
  buildProviderUpstreamHeaders,
  resolveProviderEndpointUrl,
} from "./provider-proxy"

export async function forwardGoogleGenerateContent(
  provider: ResolvedProviderConfig,
  model: string,
  payload: GoogleGenerateContentPayload,
  requestHeaders: Headers,
  options: { stream: boolean; clientSignal: AbortSignal; sessionId?: string },
): Promise<Response> {
  const modelId = encodeURIComponent(model.replace(/^models\//u, ""))
  const method = options.stream ? "streamGenerateContent" : "generateContent"
  const url = new URL(
    resolveProviderEndpointUrl(provider, `models/${modelId}:${method}`),
  )
  if (options.stream) url.searchParams.set("alt", "sse")
  const headers = buildProviderUpstreamHeaders(provider, requestHeaders)
  applyOpencodeSessionHeader(provider, headers, options.sessionId)
  headers.accept = options.stream ? "text/event-stream" : "application/json"
  const transport = getUpstreamTransportConfig()
  setPluginRequestActualModel(model.replace(/^models\//u, ""))
  return await fetchUpstreamWithLifecycle(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
    {
      clientSignal: options.clientSignal,
      headersTimeoutMs: transport.headersTimeoutMs,
      streamInactivityTimeoutMs: transport.streamInactivityTimeoutMs,
    },
  )
}
