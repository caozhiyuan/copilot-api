import { createHash } from "node:crypto"

import { events, type ServerSentEventMessage } from "fetch-event-stream"

import type {
  CreateResponsesReturn,
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputMessage,
  ResponsesPayload,
  ResponseErrorEvent,
  ResponsesResult,
  ResponsesStream,
  ResponsesTransport,
} from "~/services/copilot/create-responses"

import { isResponsesApiWebSocketEnabled as isConfiguredResponsesApiWebSocketEnabled } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import {
  createPooledWebSocketStream,
  createWebSocketUrl,
  type PooledWebSocketRequest,
} from "~/services/responses-websocket"
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
  const { accessToken, accountId } = requireCodexAuthContext()
  const headers = new Headers()
  for (const [headerName, headerValue] of requestHeaders) {
    const headerNameLower = headerName.toLowerCase()
    if (STRIPPED_CODEX_REQUEST_HEADERS.has(headerNameLower)) {
      continue
    }
    if (headerNameLower.includes("trace")) {
      continue
    }
    if (headerNameLower.startsWith("cf-")) {
      continue
    }
    headers.set(headerName, headerValue)
  }

  if (!headers.has("accept")) {
    headers.set(
      "accept",
      options.stream ? "text/event-stream" : "application/json",
    )
  }

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("chatgpt-account-id", accountId)
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  if (!headers.has("OpenAI-Beta")) {
    headers.set("OpenAI-Beta", "responses=experimental")
  }
  if (!headers.has("originator")) {
    headers.set("originator", "copilot-api")
  }
  if (!headers.has("user-agent")) {
    headers.set("user-agent", "copilot-api")
  }
  if (headers.get("user-agent")?.startsWith("opencode")) {
    headers.set("originator", "opencode")
    const sessionId = requestContext.getStore()?.sessionAffinity
    if (sessionId) {
      headers.set("session-id", sessionId)
    }
  }
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
  for (const headerName of STRIPPED_CODEX_WEBSOCKET_HEADERS) {
    headers.delete(headerName)
  }
  return Object.fromEntries(headers)
}

export function buildCodexResponsesWebSocketPayload(
  payload: ResponsesPayload,
): CodexResponsesWebSocketPayload {
  const websocketPayload: CodexResponsesWebSocketPayload = {
    ...normalizeCodexResponsesPayload(payload),
    type: "response.create",
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
    transport?: ResponsesTransport
  } = {},
): Promise<CreateResponsesReturn> {
  consola.log(`<-- model: ${payload.model}`)
  const transport = resolveCodexResponsesTransport(options.transport)
  if (payload.stream && transport === "websocket") {
    return forwardCodexResponsesOverWebSocket(payload, requestHeaders, baseUrl)
  }

  const normalizedPayload = normalizeCodexResponsesPayload(payload)

  const response = await fetch(resolveCodexResponsesUrl(baseUrl), {
    method: "POST",
    headers: buildCodexResponsesHeaders(requestHeaders, {
      stream: normalizedPayload.stream,
    }),
    body: JSON.stringify(normalizedPayload),
  })

  if (!response.ok) {
    throw new HTTPError("Failed to create codex responses", response)
  }

  if (normalizedPayload.stream) {
    return events(response)
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
): ResponsesStream => {
  const websocketRequest = prepareCodexResponsesWebSocketRequest(
    payload,
    requestHeaders,
    baseUrl,
  )

  return createCodexResponsesWebSocketStream(websocketRequest)
}

const createCodexResponsesWebSocketStream = (
  request: CodexResponsesWebSocketRequest,
): ResponsesStream =>
  createCodexResponsesSafeStream(
    createPooledWebSocketStream(request, {
      createChunk: createCodexResponsesWebSocketStreamChunk,
      isTerminalChunk: isTerminalCodexResponsesWebSocketChunk,
      openErrorMessage: "Failed to create codex responses websocket",
      streamErrorMessage: "Codex responses websocket stream error",
      terminalChunkMissingMessage:
        "Codex responses websocket ended without a terminal response",
    }),
  )

const createCodexResponsesSafeStream = async function* (
  source: AsyncIterable<ServerSentEventChunk>,
): AsyncGenerator<ServerSentEventChunk, void, unknown> {
  try {
    yield* source
  } catch (error) {
    yield createResponsesErrorServerSentEventChunk(getErrorMessage(error))
  }
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
      parsed.message = parsed.error.message
    }

    return {
      data: JSON.stringify(parsed),
      event: typeof parsed.type === "string" ? parsed.type : undefined,
      id: typeof parsed.id === "string" ? parsed.id : undefined,
    }
  } catch {
    return { data }
  }
}

const isTerminalCodexResponsesWebSocketChunk = (
  chunk: ServerSentEventChunk,
): boolean => {
  if (!chunk.data || chunk.data === "[DONE]") {
    return false
  }

  try {
    const parsed = JSON.parse(chunk.data) as { type?: unknown }
    return (
      parsed.type === "response.completed"
      || parsed.type === "response.failed"
      || parsed.type === "response.incomplete"
      || parsed.type === "error"
    )
  } catch {
    return false
  }
}

const createResponsesErrorServerSentEventChunk = (
  message: string,
): ServerSentEventChunk => {
  const errorEvent: ResponseErrorEvent = {
    code: null,
    message,
    param: null,
    sequence_number: 0,
    type: "error",
  }

  return {
    data: JSON.stringify(errorEvent),
    event: errorEvent.type,
  }
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}

const encodePoolKeyPart = (value: string): string => encodeURIComponent(value)
