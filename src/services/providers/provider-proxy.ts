import consola from "consola"
import type {
  ProviderImageEndpoint,
  ResolvedProviderConfig,
} from "~/lib/config"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

const SHARED_FORWARDABLE_HEADERS = ["accept", "user-agent"] as const

const ANTHROPIC_FORWARDABLE_HEADERS = [
  "anthropic-version",
  "anthropic-beta",
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

interface ProviderUpstreamHeaderOptions {
  contentEncoding?: string
  contentType?: string
}

type StreamingRequestInit = RequestInit & {
  duplex?: "half"
}

export function buildProviderUpstreamHeaders(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
  options: ProviderUpstreamHeaderOptions = {},
): Record<string, string> {
  const authHeaders: Record<string, string> = {}
  if (providerConfig.authType === "x-api-key") {
    authHeaders["x-api-key"] = providerConfig.apiKey
  } else {
    authHeaders.authorization = `Bearer ${providerConfig.apiKey}`
  }

  const headers: Record<string, string> = {
    "content-type": options.contentType ?? "application/json",
    ...(options.contentEncoding ?
      { "content-encoding": options.contentEncoding }
    : {}),
    accept: "application/json",
    ...authHeaders,
  }

  for (const headerName of SHARED_FORWARDABLE_HEADERS) {
    const headerValue = requestHeaders.get(headerName)
    if (headerValue) {
      headers[headerName] = headerValue
    }
  }

  if (providerConfig.type !== "anthropic") {
    return headers
  }

  for (const headerName of ANTHROPIC_FORWARDABLE_HEADERS) {
    const headerValue = requestHeaders.get(headerName)
    if (headerValue) {
      headers[headerName] = headerValue
    }
  }

  return headers
}

export function createProviderProxyResponse(
  upstreamResponse: Response,
  body?: ReadableStream<Uint8Array> | null,
): Response {
  const headers = new Headers(upstreamResponse.headers)

  for (const headerName of STRIPPED_RESPONSE_HEADERS) {
    headers.delete(headerName)
  }

  return new Response(body ?? upstreamResponse.body, {
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
  consola.log(`<-- model: ${payload.model}`)
  return await fetch(`${providerConfig.baseUrl}/v1/messages`, {
    method: "POST",
    headers: buildProviderUpstreamHeaders(providerConfig, requestHeaders),
    body: JSON.stringify(payload),
  })
}

export async function forwardProviderChatCompletions(
  providerConfig: ResolvedProviderConfig,
  payload: ChatCompletionsPayload,
  requestHeaders: Headers,
): Promise<Response> {
  consola.log(`<-- model: ${payload.model}`)
  return await fetch(`${providerConfig.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: buildProviderUpstreamHeaders(providerConfig, requestHeaders),
    body: JSON.stringify(payload),
  })
}

export async function forwardProviderResponses(
  providerConfig: ResolvedProviderConfig,
  payload: ResponsesPayload,
  requestHeaders: Headers,
): Promise<Response> {
  consola.log(`<-- model: ${payload.model}`)
  return await fetch(`${providerConfig.baseUrl}/v1/responses`, {
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

export async function forwardProviderImageRequest(
  providerConfig: ResolvedProviderConfig,
  endpoint: ProviderImageEndpoint,
  request: Request,
): Promise<Response> {
  const body = request.body
  const requestInit: StreamingRequestInit = {
    method: "POST",
    headers: buildProviderUpstreamHeaders(providerConfig, request.headers, {
      contentEncoding: request.headers.get("content-encoding") ?? undefined,
      contentType: request.headers.get("content-type") ?? "application/json",
    }),
    body,
    signal: request.signal,
  }

  if (body) {
    requestInit.duplex = "half"
  }

  return await fetch(
    `${providerConfig.baseUrl}/v1/images/${endpoint}`,
    requestInit,
  )
}
