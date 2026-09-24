import { createHash } from "node:crypto"

import type { ServerSentEventMessage } from "fetch-event-stream"

import type {
  CreateResponsesReturn,
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputMessage,
  ResponsesPayload,
  ResponsesResult,
  ResponsesStream,
  ResponsesTransport,
} from "~/lib/types/responses"

import {
  getUpstreamTransportConfig,
  isResponsesApiWebSocketEnabled as isConfiguredResponsesApiWebSocketEnabled,
} from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import {
  createPooledWebSocketStream,
  createWebSocketUrl,
  type PooledWebSocketRequest,
} from "~/services/responses-websocket"
import {
  createResponsesSafeStream,
  encodePoolKeyPart,
  getResponsesStreamTerminalDisposition,
} from "~/services/responses-websocket-helpers"
import { createResponsesHttpEventStream } from "~/services/responses-http"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"
import { requestContext } from "~/lib/request-context"
import consola from "consola"

export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api"

const CODEX_RESPONSE_METADATA_EVENT = "codex.response.metadata"
const RESPONSE_CREATED_EVENT = "response.created"

type CodexResponsesWebSocketPayload = ResponsesPayload & {
  type: "response.create"
}

type ServerSentEventChunk = ServerSentEventMessage

type CodexResponsesWebSocketRequest =
  PooledWebSocketRequest<CodexResponsesWebSocketPayload>

interface CodexResponsesHeaderOptions {
  stream?: boolean | null
}

const STRIPPED_CODEX_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "authorization",
  "cdn-loop",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "true-client-ip",
  "upgrade",
  "x-api-key",
  "x-forwarded-for",
  "x-forwarded-proto",
])

const STRIPPED_CODEX_WEBSOCKET_HEADERS = new Set(["accept", "content-type"])

const shouldForwardCodexRequestHeader = (headerName: string): boolean => {
  const headerNameLower = headerName.toLowerCase()
  return (
    !STRIPPED_CODEX_REQUEST_HEADERS.has(headerNameLower)
    && !headerNameLower.includes("trace")
    && !headerNameLower.startsWith("cf-")
  )
}

const buildForwardedCodexRequestHeaders = (
  requestHeaders: Headers,
): Headers => {
  const headers = new Headers()
  for (const [headerName, headerValue] of requestHeaders) {
    if (shouldForwardCodexRequestHeader(headerName)) {
      headers.set(headerName, headerValue)
    }
  }
  return headers
}

const setDefaultCodexHeader = (
  headers: Headers,
  headerName: string,
  headerValue: string,
): void => {
  if (!headers.has(headerName)) {
    headers.set(headerName, headerValue)
  }
}

const applyOpencodeCodexHeaders = (headers: Headers): void => {
  if (!headers.get("user-agent")?.startsWith("opencode")) {
    return
  }

  headers.set("originator", "opencode")
  const sessionId = requestContext.getStore()?.sessionAffinity
  if (sessionId) {
    headers.set("session-id", sessionId)
  }
}

const requireCodexAuthContext = (): {
  accessToken: string
  accountId: string
} => {
  const accessToken = state.codexAccessToken
  const accountId = state.codexAccountId

  if (!accessToken) {
    throw new Error("Codex access token is not loaded")
  }

  if (!accountId) {
    throw new Error("Codex account id is not loaded")
  }

  return { accessToken, accountId }
}

export function resolveCodexResponsesUrl(
  baseUrl: string = CODEX_API_BASE_URL,
): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "")
  if (!normalized) {
    return `${CODEX_API_BASE_URL}/codex/responses`
  }

  if (normalized.endsWith("/codex/responses")) {
    return normalized
  }

  if (normalized.endsWith("/codex")) {
    return `${normalized}/responses`
  }

  return `${normalized}/codex/responses`
}

export function buildCodexResponsesHeaders(
  requestHeaders: Headers,
  options: CodexResponsesHeaderOptions = {},
): Headers {
  const headers = buildCodexRequestHeaders(requestHeaders)

  setDefaultCodexHeader(
    headers,
    "accept",
    options.stream ? "text/event-stream" : "application/json",
  )
  setDefaultCodexHeader(headers, "content-type", "application/json")
  return headers
}

export function buildCodexRequestHeaders(requestHeaders: Headers): Headers {
  const { accessToken, accountId } = requireCodexAuthContext()
  const headers = buildForwardedCodexRequestHeaders(requestHeaders)

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("chatgpt-account-id", accountId)
  setDefaultCodexHeader(headers, "originator", "copilot-api")
  setDefaultCodexHeader(headers, "user-agent", "copilot-api")
  applyOpencodeCodexHeaders(headers)
  return headers
}

export function resolveCodexResponsesTransport(
  transport?: ResponsesTransport,
): ResponsesTransport {
  return (
    transport
    ?? (isConfiguredResponsesApiWebSocketEnabled() ? "websocket" : "http")
  )
}

export function buildCodexResponsesWebSocketHeaders(
  requestHeaders: Headers,
): Record<string, string> {
  const headers = buildCodexResponsesHeaders(requestHeaders)
  setDefaultCodexHeader(
    headers,
    "openai-beta",
    "responses_websockets=2026-02-06",
  )
  for (const headerName of STRIPPED_CODEX_WEBSOCKET_HEADERS) {
    headers.delete(headerName)
  }
  return Object.fromEntries(headers)
}

export function buildCodexResponsesWebSocketPayload(
  payload: ResponsesPayload,
): CodexResponsesWebSocketPayload {
  const websocketPayload: CodexResponsesWebSocketPayload = {
    type: "response.create",
    ...normalizeCodexResponsesPayload(payload),
  }

  delete websocketPayload.stream

  return websocketPayload
}

export function buildCodexResponsesWebSocketUrl(
  baseUrl: string = CODEX_API_BASE_URL,
): string {
  return createWebSocketUrl(resolveCodexResponsesUrl(baseUrl))
}

export function prepareCodexResponsesWebSocketRequest(
  payload: ResponsesPayload,
  requestHeaders: Headers,
  baseUrl: string = CODEX_API_BASE_URL,
): CodexResponsesWebSocketRequest {
  const headers = buildCodexResponsesWebSocketHeaders(requestHeaders)

  return {
    headers,
    payload: buildCodexResponsesWebSocketPayload(payload),
    poolKey: buildCodexResponsesWebSocketPoolKey(payload, headers, baseUrl),
    url: buildCodexResponsesWebSocketUrl(baseUrl),
  }
}

export async function forwardCodexResponses(
  payload: ResponsesPayload,
  requestHeaders: Headers,
  baseUrl: string = CODEX_API_BASE_URL,
  options: {
    clientSignal?: AbortSignal
    onResponseHeaders?: (headers: Headers) => void
    transport?: ResponsesTransport
  } = {},
): Promise<CreateResponsesReturn> {
  consola.log(`<-- model: ${payload.model}`)
  options.clientSignal?.throwIfAborted()
  const transport = resolveCodexResponsesTransport(options.transport)
  if (payload.stream && transport === "websocket") {
    return forwardCodexResponsesOverWebSocket(
      payload,
      requestHeaders,
      baseUrl,
      options.clientSignal,
      options.onResponseHeaders,
    )
  }

  const normalizedPayload = normalizeCodexResponsesPayload(payload)

  const transportConfig = getUpstreamTransportConfig()
  const response = await fetchUpstreamWithLifecycle(
    resolveCodexResponsesUrl(baseUrl),
    {
      method: "POST",
      headers: buildCodexResponsesHeaders(requestHeaders, {
        stream: normalizedPayload.stream,
      }),
      body: JSON.stringify(normalizedPayload),
    },
    {
      clientSignal: options.clientSignal,
      headersTimeoutMs: transportConfig.headersTimeoutMs,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
    },
  )

  if (!response.ok) {
    throw new HTTPError("Failed to create codex responses", response)
  }

  options.onResponseHeaders?.(response.headers)

  if (normalizedPayload.stream) {
    return createResponsesSafeStream(createResponsesHttpEventStream(response))
  }

  return (await response.json()) as ResponsesResult
}

const normalizeCodexResponsesPayload = (
  payload: ResponsesPayload,
): ResponsesPayload => {
  const normalizedPayload: ResponsesPayload = {
    ...payload,
    store: false,
  }

  delete normalizedPayload.temperature
  delete normalizedPayload.top_p
  delete normalizedPayload.max_output_tokens
  delete normalizedPayload.metadata

  if (
    (typeof normalizedPayload.instructions === "string"
      && normalizedPayload.instructions.trim().length > 0)
    || !Array.isArray(normalizedPayload.input)
  ) {
    return normalizedPayload
  }

  const instructions: Array<string> = []
  let messageCount = 0
  const remainingInput = normalizedPayload.input.filter((inputItem) => {
    const message = getResponseInputMessage(inputItem)
    if (!message) {
      return true
    }

    messageCount += 1
    if (message.role !== "system" || messageCount > 3) {
      return true
    }

    const systemPrompt = getTextContent(message.content)
    if (systemPrompt === undefined) {
      return true
    }
    if (systemPrompt.trim().length > 0) {
      instructions.push(systemPrompt)
    }

    return false
  })

  if (remainingInput.length === normalizedPayload.input.length) {
    return normalizedPayload
  }

  if (instructions.length > 0) {
    // Codex expects system prompts in instructions instead of input messages.
    normalizedPayload.instructions = instructions.join("\n\n")
  }

  if (remainingInput.length > 0) {
    normalizedPayload.input = remainingInput
  } else {
    delete normalizedPayload.input
  }

  return normalizedPayload
}

const getResponseInputMessage = (
  inputItem: ResponseInputItem,
): ResponseInputMessage | undefined => {
  if (typeof inputItem !== "object" || inputItem === null) {
    return undefined
  }

  const { role, type } = inputItem as {
    role?: unknown
    type?: unknown
  }
  if (typeof role !== "string" || (type !== undefined && type !== "message")) {
    return undefined
  }

  return inputItem as ResponseInputMessage
}

const getTextContent = (
  content: ResponseInputMessage["content"],
): string | undefined => {
  if (typeof content === "string") {
    return content
  }

  if (content === undefined) {
    return ""
  }

  if (!Array.isArray(content)) {
    return undefined
  }

  const textBlocks: Array<string> = []
  for (const contentBlock of content) {
    const text = getTextBlock(contentBlock)
    if (text === undefined) {
      return undefined
    }

    if (text.length > 0) {
      textBlocks.push(text)
    }
  }

  return textBlocks.join("\n\n")
}

const getTextBlock = (
  contentBlock: ResponseInputContent,
): string | undefined => {
  if (typeof contentBlock !== "object" || contentBlock === null) {
    return undefined
  }

  const { text, type } = contentBlock as {
    text?: unknown
    type?: unknown
  }

  if (type !== undefined && type !== "input_text" && type !== "output_text") {
    return undefined
  }

  return typeof text === "string" ? text : undefined
}

const buildCodexResponsesWebSocketPoolKey = (
  payload: ResponsesPayload,
  headers: Record<string, string>,
  baseUrl: string,
): string => {
  const authFingerprint = createHash("sha256")
    .update(
      `${state.codexAccessToken ?? "missing-token"}:${state.codexAccountId ?? "missing-account"}`,
    )
    .digest("hex")
    .slice(0, 16)
  const headerFingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(headers)
          .filter(([headerName]) => !headerName.toLowerCase().includes("trace"))
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex")
    .slice(0, 16)

  return [
    "codex",
    resolveCodexResponsesUrl(baseUrl),
    payload.model,
    authFingerprint,
    headerFingerprint,
  ]
    .map(encodePoolKeyPart)
    .join("|")
}

const forwardCodexResponsesOverWebSocket = (
  payload: ResponsesPayload,
  requestHeaders: Headers,
  baseUrl: string,
  clientSignal?: AbortSignal,
  onResponseHeaders?: (headers: Headers) => void,
): ResponsesStream => {
  const websocketRequest = prepareCodexResponsesWebSocketRequest(
    payload,
    requestHeaders,
    baseUrl,
  )

  return createCodexResponsesWebSocketStream(
    websocketRequest,
    clientSignal,
    onResponseHeaders,
  )
}

const createCodexResponsesWebSocketStream = (
  request: CodexResponsesWebSocketRequest,
  clientSignal?: AbortSignal,
  onResponseHeaders?: (headers: Headers) => void,
): ResponsesStream => {
  const transportConfig = getUpstreamTransportConfig()
  return createResponsesSafeStream(
    createClientPreflightStream(
      filterCodexResponsesWebSocketMetadata(
        createPooledWebSocketStream(request, {
          createChunk: createCodexResponsesWebSocketStreamChunk,
          maxBufferedBytes: transportConfig.websocketMaxBufferedBytes,
          maxBufferedMessages: transportConfig.websocketMaxBufferedMessages,
          getTerminalDisposition: getResponsesStreamTerminalDisposition,
          openErrorMessage: "Failed to create codex responses websocket",
          openTimeoutMs: transportConfig.websocketOpenTimeoutMs,
          poolIdleTimeoutMs: transportConfig.websocketPoolIdleTimeoutMs,
          streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
          streamErrorMessage:
            "Upstream connection lost, Codex responses websocket stream error",
          terminalChunkMissingMessage:
            "Codex responses websocket ended without a terminal response, retry your request.",
        }),
        onResponseHeaders,
      ),
      clientSignal,
    ),
  )
}

const filterCodexResponsesWebSocketMetadata = async function* (
  source: AsyncIterable<ServerSentEventChunk>,
  onResponseHeaders?: (headers: Headers) => void,
): AsyncGenerator<ServerSentEventChunk, void, unknown> {
  const pendingChunks: Array<ServerSentEventChunk> = []
  let responseStarted = false

  for await (const chunk of source) {
    const metadataHeaders = getCodexResponseMetadataHeaders(chunk)
    if (metadataHeaders !== undefined) {
      if (!responseStarted) {
        onResponseHeaders?.(metadataHeaders)
      }
      continue
    }

    if (!responseStarted) {
      if (chunk.event !== RESPONSE_CREATED_EVENT) {
        pendingChunks.push(chunk)
        continue
      }

      responseStarted = true
      for (const pendingChunk of pendingChunks) {
        yield pendingChunk
      }
      pendingChunks.length = 0
    }

    yield chunk
  }

  for (const pendingChunk of pendingChunks) {
    yield pendingChunk
  }
}

const getCodexResponseMetadataHeaders = (
  chunk: ServerSentEventChunk,
): Headers | undefined => {
  if (chunk.event !== CODEX_RESPONSE_METADATA_EVENT) return undefined
  if (!chunk.data || chunk.data === "[DONE]") return new Headers()

  let parsed: { headers?: unknown }
  try {
    parsed = JSON.parse(chunk.data) as typeof parsed
  } catch {
    return new Headers()
  }

  const headers = new Headers()
  if (typeof parsed.headers !== "object" || parsed.headers === null) {
    return headers
  }

  for (const [headerName, headerValue] of Object.entries(parsed.headers)) {
    if (typeof headerValue === "string") {
      try {
        headers.set(headerName, headerValue)
      } catch {
        // Ignore malformed metadata headers without exposing the internal event.
      }
    }
  }
  return headers
}

const createClientPreflightStream = async function* <T>(
  source: AsyncIterable<T>,
  clientSignal?: AbortSignal,
): AsyncGenerator<T, void, unknown> {
  if (clientSignal?.aborted) return
  yield* source
}

const createCodexResponsesWebSocketStreamChunk = (
  data: string,
): ServerSentEventChunk => {
  if (data === "[DONE]") {
    return { data }
  }

  try {
    const parsed = JSON.parse(data) as {
      id?: unknown
      type?: unknown
      error?: {
        message: string
      }
      message?: string
    }

    if (parsed.type === "error" && parsed.error) {
      consola.warn("Codex responses websocket stream error:", parsed.error)
      parsed.message = parsed.error.message
    }

    return {
      event: typeof parsed.type === "string" ? parsed.type : undefined,
      data: JSON.stringify(parsed),
      id: typeof parsed.id === "string" ? parsed.id : undefined,
    }
  } catch {
    return { data }
  }
}
