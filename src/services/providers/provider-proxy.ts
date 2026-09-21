import consola from "consola"
import {
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici"

import {
  getUpstreamTransportConfig,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { requestContext } from "~/lib/request-context"
import { createTimeoutDispatcher } from "~/lib/timeout-dispatcher"
import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"
import type { ResponsesPayload } from "~/lib/types/responses"
import { parseUserIdMetadata } from "~/lib/utils"
import type { EmbeddingRequest } from "~/services/copilot/create-embeddings"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"

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

const OPENCODE_GO_PROVIDER_NAME = "opencode-go"
const OPENCODE_SESSION_HEADER = "x-opencode-session"

const resolveOpencodeMessagesSession = (
  payload: AnthropicMessagesPayload,
): string | undefined => {
  const sessionAffinity = requestContext.getStore()?.sessionAffinity?.trim()
  if (sessionAffinity) {
    return sessionAffinity
  }

  const userId = payload.metadata?.user_id
  if (!userId?.trim()) {
    return undefined
  }

  const { sessionId } = parseUserIdMetadata(userId)
  return sessionId ?? userId
}

const applyOpencodeSessionHeader = (
  providerConfig: ResolvedProviderConfig,
  headers: Record<string, string>,
  session: string | undefined,
): void => {
  if (providerConfig.name !== OPENCODE_GO_PROVIDER_NAME || !session) {
    return
  }
  headers[OPENCODE_SESSION_HEADER] = session
}

export function createProviderProxyResponse(
  upstreamResponse: Response,
  body?: ReadableStream<Uint8Array> | null,
): Response {
  return new Response(body ?? upstreamResponse.body, {
    headers: createProviderProxyResponseHeaders(upstreamResponse.headers),
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
  })
}

export function createProviderProxyResponseHeaders(
  upstreamHeaders: Headers,
): Headers {
  const headers = new Headers(upstreamHeaders)

  for (const headerName of STRIPPED_RESPONSE_HEADERS) {
    headers.delete(headerName)
  }

  return headers
}

export async function forwardProviderMessages(
  providerConfig: ResolvedProviderConfig,
  payload: AnthropicMessagesPayload,
  requestHeaders: Headers,
  options: { clientSignal?: AbortSignal } = {},
): Promise<Response> {
  consola.log(`<-- model: ${payload.model}`)
  const headers = buildProviderUpstreamHeaders(providerConfig, requestHeaders)
  applyOpencodeSessionHeader(
    providerConfig,
    headers,
    resolveOpencodeMessagesSession(payload),
  )
  const transportConfig = getUpstreamTransportConfig()
  return await fetchUpstreamWithLifecycle(
    `${providerConfig.baseUrl}/v1/messages`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
    {
      clientSignal: options.clientSignal,
      headersTimeoutMs: transportConfig.headersTimeoutMs,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
    },
  )
}

export async function forwardProviderChatCompletions(
  providerConfig: ResolvedProviderConfig,
  payload: ChatCompletionsPayload,
  requestHeaders: Headers,
  options: { clientSignal?: AbortSignal } = {},
): Promise<Response> {
  consola.log(`<-- model: ${payload.model}`)
  const headers = buildProviderUpstreamHeaders(providerConfig, requestHeaders)
  applyOpencodeSessionHeader(
    providerConfig,
    headers,
    payload.prompt_cache_key?.trim() || undefined,
  )
  const transportConfig = getUpstreamTransportConfig()
  return await fetchUpstreamWithLifecycle(
    `${providerConfig.baseUrl}/v1/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
    {
      clientSignal: options.clientSignal,
      headersTimeoutMs: transportConfig.headersTimeoutMs,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
    },
  )
}

export async function forwardProviderEmbeddings(
  providerConfig: ResolvedProviderConfig,
  payload: EmbeddingRequest,
  requestHeaders: Headers,
  options: { clientSignal?: AbortSignal } = {},
): Promise<Response> {
  consola.log(`<-- model: ${payload.model}`)
  const transportConfig = getUpstreamTransportConfig()
  return await fetchUpstreamWithLifecycle(
    `${providerConfig.baseUrl}/v1/embeddings`,
    {
      method: "POST",
      headers: buildProviderUpstreamHeaders(providerConfig, requestHeaders),
      body: JSON.stringify(payload),
    },
    {
      clientSignal: options.clientSignal,
      headersTimeoutMs: transportConfig.headersTimeoutMs,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
    },
  )
}

export async function forwardProviderResponses(
  providerConfig: ResolvedProviderConfig,
  payload: ResponsesPayload,
  requestHeaders: Headers,
  options: { clientSignal?: AbortSignal } = {},
): Promise<Response> {
  consola.log(`<-- model: ${payload.model}`)
  const transportConfig = getUpstreamTransportConfig()
  const headers = buildProviderUpstreamHeaders(providerConfig, requestHeaders)
  applyOpencodeSessionHeader(
    providerConfig,
    headers,
    payload.prompt_cache_key?.trim() || undefined,
  )
  return await fetchUpstreamWithLifecycle(
    `${providerConfig.baseUrl}/v1/responses`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
    {
      headersTimeoutMs: transportConfig.headersTimeoutMs,
      clientSignal: options.clientSignal,
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
  options: { clientSignal?: AbortSignal } = {},
): Promise<Response> {
  const headers = buildProviderUpstreamHeaders(providerConfig, request.headers)
  const body = await request.arrayBuffer()
  const transportConfig = getUpstreamTransportConfig()

  return await fetchUpstreamWithLifecycle(
    resolveProviderRequestUrl(providerConfig, request.url, "/v1/alpha/search"),
    {
      method: "POST",
      headers,
      body,
    },
    {
      clientSignal: options.clientSignal,
      headersTimeoutMs: transportConfig.headersTimeoutMs,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
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
