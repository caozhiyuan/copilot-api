import { createHash } from "node:crypto"

import { events, type ServerSentEventMessage } from "fetch-event-stream"

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
  getResponsesTransportConfig,
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
  isTerminalResponsesStreamChunk,
} from "~/services/responses-websocket-helpers"
import { fetchResponsesWithLifecycle } from "~/services/responses-http"
import { requestContext } from "~/lib/request-context"
import consola from "consola"

export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api"

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
  signal?: AbortSignal,
): CodexResponsesWebSocketRequest {
  const headers = buildCodexResponsesWebSocketHeaders(requestHeaders)

  return {
    headers,
    payload: buildCodexResponsesWebSocketPayload(payload),
    poolKey: buildCodexResponsesWebSocketPoolKey(payload, headers, baseUrl),
    signal,
    url: buildCodexResponsesWebSocketUrl(baseUrl),
  }
}

export async function forwardCodexResponses(
  payload: ResponsesPayload,
  requestHeaders: Headers,
  baseUrl: string = CODEX_API_BASE_URL,
  options: {
    signal?: AbortSignal
    transport?: ResponsesTransport
  } = {},
): Promise<CreateResponsesReturn> {
  consola.log(`<-- model: ${payload.model}`)
  const transport = resolveCodexResponsesTransport(options.transport)
  if (payload.stream && transport === "websocket") {
    return forwardCodexResponsesOverWebSocket(
      payload,
      requestHeaders,
      baseUrl,
      options.signal,
    )
  }

  const normalizedPayload = normalizeCodexResponsesPayload(payload)

  const transportConfig = getResponsesTransportConfig()
  const response = await fetchResponsesWithLifecycle(
    resolveCodexResponsesUrl(baseUrl),
    {
      method: "POST",
      headers: buildCodexResponsesHeaders(requestHeaders, {
        stream: normalizedPayload.stream,
      }),
      body: JSON.stringify(normalizedPayload),
    },
    {
      headersTimeoutMs: transportConfig.headersTimeoutMs,
      signal: options.signal,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
    },
  )

  if (!response.ok) {
    throw new HTTPError("Failed to create codex responses", response)
  }

  if (normalizedPayload.stream) {
    return createCodexResponsesHttpStream(response, options.signal)
  }

  return (await response.json()) as ResponsesResult
}

const createCodexResponsesHttpStream = async function* (
  response: Response,
  signal?: AbortSignal,
): ResponsesStream {
  const responseBody = response.body
  if (!responseBody) {
    return
  }

  const reader =
    responseBody.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const readerBackedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read()
      if (result.done) {
        controller.close()
        return
      }

      controller.enqueue(result.value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })

  try {
    yield* createResponsesSafeStream(
      events(new Response(readerBackedBody), signal),
      { signal },
    )
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The reader may already have failed or been cancelled downstream.
    } finally {
      reader.releaseLock()
    }
  }
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
  signal?: AbortSignal,
): ResponsesStream => {
  const websocketRequest = prepareCodexResponsesWebSocketRequest(
    payload,
    requestHeaders,
    baseUrl,
    signal,
  )

  return createCodexResponsesWebSocketStream(websocketRequest)
}

const createCodexResponsesWebSocketStream = (
  request: CodexResponsesWebSocketRequest,
): ResponsesStream => {
  const transportConfig = getResponsesTransportConfig()
  return createResponsesSafeStream(
    createPooledWebSocketStream(request, {
      createChunk: createCodexResponsesWebSocketStreamChunk,
      maxBufferedBytes: transportConfig.websocketMaxBufferedBytes,
      maxBufferedMessages: transportConfig.websocketMaxBufferedMessages,
      isTerminalChunk: isTerminalResponsesStreamChunk,
      openErrorMessage: "Failed to create codex responses websocket",
      openTimeoutMs: transportConfig.websocketOpenTimeoutMs,
      poolIdleTimeoutMs: transportConfig.websocketPoolIdleTimeoutMs,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
      streamErrorMessage: "Codex responses websocket stream error",
      terminalChunkMissingMessage:
        "Codex responses websocket ended without a terminal response",
    }),
    { signal: request.signal },
  )
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
