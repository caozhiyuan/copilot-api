import consola from "consola"
import {
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici"

import type { ResolvedProviderConfig } from "~/lib/config"
import { createTimeoutDispatcher } from "~/lib/timeout-dispatcher"
import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"
import type { ResponsesPayload } from "~/lib/types/responses"
import { getResponsesTransportConfig } from "~/lib/config"
import { fetchResponsesWithLifecycle } from "~/services/responses-http"

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

export function buildProviderUpstreamHeaders(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
): Record<string, string> {
  const authHeaders: Record<string, string> = {}
  if (providerConfig.authType === "x-api-key") {
    authHeaders["x-api-key"] = providerConfig.apiKey
  } else {
    authHeaders.authorization = `Bearer ${providerConfig.apiKey}`
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
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
  options: { signal?: AbortSignal } = {},
): Promise<Response> {
  consola.log(`<-- model: ${payload.model}`)
  const transportConfig = getResponsesTransportConfig()
  return await fetchResponsesWithLifecycle(
    `${providerConfig.baseUrl}/v1/responses`,
    {
      method: "POST",
      headers: buildProviderUpstreamHeaders(providerConfig, requestHeaders),
      body: JSON.stringify(payload),
    },
    {
      headersTimeoutMs: transportConfig.headersTimeoutMs,
      signal: options.signal,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
    },
  )
}

const PROVIDER_MODELS_TIMEOUT_MS = 15_000

export async function forwardProviderModels(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
): Promise<Response> {
  return await fetch(`${providerConfig.baseUrl}/v1/models`, {
    method: "GET",
    headers: buildProviderUpstreamHeaders(providerConfig, requestHeaders),
    signal: AbortSignal.timeout(PROVIDER_MODELS_TIMEOUT_MS),
  })
}

/** Align with Codex images: long-running generation/edits need a generous cap. */
const PROVIDER_IMAGES_TIMEOUT_MS = 15 * 60 * 1000

const providerImagesDispatcher = createTimeoutDispatcher(
  PROVIDER_IMAGES_TIMEOUT_MS,
)

function resolveProviderRequestUrl(
  providerConfig: ResolvedProviderConfig,
  requestUrl: string,
  path: string,
): string {
  const upstreamUrl = new URL(`${providerConfig.baseUrl}${path}`)
  upstreamUrl.search = new URL(requestUrl, "http://localhost").search
  return upstreamUrl.toString()
}

export async function forwardProviderAlphaSearch(
  providerConfig: ResolvedProviderConfig,
  request: Request,
): Promise<Response> {
  const headers = buildProviderUpstreamHeaders(providerConfig, request.headers)
  const body = await request.arrayBuffer()

  return await fetch(
    resolveProviderRequestUrl(providerConfig, request.url, "/v1/alpha/search"),
    {
      method: "POST",
      headers,
      body,
    },
  )
}

export async function forwardProviderImages(
  providerConfig: ResolvedProviderConfig,
  request: Request,
  operation: "generations" | "edits",
): Promise<Response> {
  const headers = buildProviderUpstreamHeaders(providerConfig, request.headers)
  const contentType = request.headers.get("content-type")
  if (contentType) {
    headers["content-type"] = contentType
  } else if (operation === "edits") {
    delete headers["content-type"]
  }

  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers,
    body: request.body,
    duplex: "half",
    signal: AbortSignal.timeout(PROVIDER_IMAGES_TIMEOUT_MS),
  }

  const upstreamUrl = resolveProviderRequestUrl(
    providerConfig,
    request.url,
    `/v1/images/${operation}`,
  )

  if (typeof Bun !== "undefined") {
    return await fetch(upstreamUrl, init)
  }

  // Node's global fetch keeps Undici's shorter default headers/body timeouts.
  // Use an explicit dispatcher so the documented 15-minute cap applies there.
  return (await undiciFetch(upstreamUrl, {
    ...init,
    dispatcher: providerImagesDispatcher,
  } as unknown as UndiciRequestInit)) as unknown as Response
}
