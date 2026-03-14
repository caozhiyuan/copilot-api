import type { ResolvedProviderConfig } from "~/lib/config"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

const FORWARDABLE_HEADERS = [
  "anthropic-version",
  "anthropic-beta",
  "accept",
  "user-agent",
] as const

const STRIPPED_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const

export function buildProviderUpstreamHeaders(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "x-api-key": providerConfig.apiKey,
  }

  for (const headerName of FORWARDABLE_HEADERS) {
    const headerValue = requestHeaders.get(headerName)
    if (headerValue) {
      headers[headerName] = headerValue
    }
  }

  return headers
}

export function createProviderProxyResponse(
  upstreamResponse: Response,
): Response {
  const headers = new Headers(upstreamResponse.headers)

  for (const headerName of STRIPPED_RESPONSE_HEADERS) {
    headers.delete(headerName)
  }

  return new Response(upstreamResponse.body, {
    headers,
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
  })
}

export async function forwardProviderMessages(
  providerConfig: ResolvedProviderConfig,
  payload: AnthropicMessagesPayload,
  requestHeaders: Headers,
): Promise<Response> {
  return await fetch(`${providerConfig.baseUrl}/v1/messages`, {
    method: "POST",
    headers: buildProviderUpstreamHeaders(providerConfig, requestHeaders),
    body: JSON.stringify(payload),
  })
}

export async function forwardProviderModels(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
): Promise<Response> {
  return await fetch(`${providerConfig.baseUrl}/v1/models`, {
    method: "GET",
    headers: buildProviderUpstreamHeaders(providerConfig, requestHeaders),
  })
}
