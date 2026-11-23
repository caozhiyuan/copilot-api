import consola from "consola"
import { createHash } from "node:crypto"

import type { SubagentMarker } from "~/lib/http/subagent"
import type { ResponsesStreamChunk } from "~/lib/http/responses-stream-event"
import type {
  CreateResponsesReturn,
  ResponsesPayload,
  ResponsesResult,
  ResponsesStream,
  ResponsesTransport,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import type { PooledWebSocketRequest } from "~/services/responses-websocket"

import {
  copilotBaseUrl,
  copilotHeaders,
  copilotWebSocketHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "~/lib/providers/api-config"
import { COMPACT_REQUEST, type CompactType } from "~/lib/http/compact"
import {
  getUpstreamTransportConfig,
  isOutputEncryptedContentDisabled,
} from "~/lib/config"
import {
  logCopilotQuotaSnapshots,
  logCopilotRateLimits,
} from "~/lib/providers/copilot-rate-limit"
import { HTTPError } from "~/lib/http/error"
import { getResponsesContinuationSession } from "~/lib/responses-continuation"
import { setPluginRequestActualModel } from "~/lib/http/request-context"
import { state } from "~/lib/state"
import {
  createWebSocketUrl,
  ResponsesWebSocketMessageTooLargeError,
} from "~/services/responses-websocket"
import { createContinuableResponsesWebSocketStream } from "~/services/responses-websocket-continuation"
import {
  createResponsesErrorServerSentEventChunk,
  createResponsesSafeStream,
  decodeResponsesWebSocketChunk,
  encodePoolKeyPart,
  getResponsesStreamTerminalDisposition,
} from "~/services/responses-websocket-helpers"
import { createResponsesHttpEventStream } from "~/services/responses-http"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"

// Copilot can return a generic internal_error for messages above 16 MiB.
export const COPILOT_RESPONSES_WEBSOCKET_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
const COPILOT_RESPONSES_HTTP_MAX_REQUEST_BYTES = 32 * 1024 * 1024
const COPILOT_RESPONSES_MIN_OUTPUT_TOKENS = 16

interface ResponsesRequestOptions {
  vision: boolean
  initiator: "agent" | "user"
  subagentMarker?: SubagentMarker | null
  requestId: string
  sessionId?: string
  compactType?: CompactType
  transport?: ResponsesTransport
  clientSignal?: AbortSignal
  allowCompactionHttpFallback?: boolean
}

export const createResponses = async (
  payload: ResponsesPayload,
  {
    vision,
    initiator,
    subagentMarker,
    requestId,
    sessionId,
    compactType,
    transport = "http",
    clientSignal,
    allowCompactionHttpFallback,
  }: ResponsesRequestOptions,
): Promise<CreateResponsesReturn> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  // Capture baseUrl alongside the auth headers so fallback never pairs an old
  // token with a refreshed host.
  const baseUrl = copilotBaseUrl(state)
  const headers: Record<string, string> = {
    ...copilotHeaders(state, requestId, vision),
    "x-initiator": initiator,
  }

  prepareInteractionHeaders(sessionId, Boolean(subagentMarker), headers)

  prepareForCompact(headers, compactType)

  // service_tier is not supported by github copilot
  payload.service_tier = undefined
  let upstreamPayload = omitUnsupportedCopilotInclude(payload)
  const maxOutputTokens = upstreamPayload.max_output_tokens
  if (
    typeof maxOutputTokens === "number"
    && Number.isInteger(maxOutputTokens)
    && maxOutputTokens > 0
    && maxOutputTokens < COPILOT_RESPONSES_MIN_OUTPUT_TOKENS
  ) {
    upstreamPayload = {
      ...upstreamPayload,
      max_output_tokens: COPILOT_RESPONSES_MIN_OUTPUT_TOKENS,
    }
  }

  consola.log(`<-- model: ${payload.model}`)

  const effectiveTransport =
    compactType === COMPACT_REQUEST ? "http" : transport

  setPluginRequestActualModel(payload.model)
  if (payload.stream === true && effectiveTransport === "websocket") {
    clientSignal?.throwIfAborted()
    const websocketRequest = prepareResponsesWebSocketRequest(
      upstreamPayload,
      headers,
      {
        baseUrl,
        requestId,
        subagentMarker,
      },
    )
    // A client-supplied parent may refer to history only the socket can see.
    const canFallBack =
      allowCompactionHttpFallback
      && upstreamPayload.previous_response_id == null
    const stream = createPooledResponsesWebSocketStream(
      websocketRequest,
      clientSignal,
      getResponsesContinuationSession(),
      canFallBack ?
        () =>
          streamOversizedCompactionOverHttp(
            baseUrl,
            upstreamPayload,
            headers,
            clientSignal,
          )
      : undefined,
    )
    return stream
  }

  return await createHttpResponses(
    baseUrl,
    upstreamPayload,
    headers,
    clientSignal,
  )
}

const omitUnsupportedCopilotInclude = (
  payload: ResponsesPayload,
): ResponsesPayload => {
  if (
    !payload.include?.includes("output.encrypted_content")
    || !isOutputEncryptedContentDisabled(payload.model)
  ) {
    return payload
  }

  const include = payload.include.filter(
    (item) => item !== "output.encrypted_content",
  )
  const upstreamPayload = { ...payload }
  if (include.length === 0) {
    delete upstreamPayload.include
  } else {
    upstreamPayload.include = include
  }
  return upstreamPayload
}

const createHttpResponses = async (
  baseUrl: string,
  payload: ResponsesPayload,
  headers: Record<string, string>,
  clientSignal?: AbortSignal,
): Promise<CreateResponsesReturn> => {
  const response = await fetchHttpResponses(
    baseUrl,
    JSON.stringify(payload),
    headers,
    clientSignal,
  )
  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return createResponsesSafeStream(createResponsesHttpEventStream(response))
  }

  return (await response.json()) as ResponsesResult
}

const fetchHttpResponses = async (
  baseUrl: string,
  body: string,
  headers: Record<string, string>,
  clientSignal?: AbortSignal,
): Promise<Response> => {
  const transportConfig = getUpstreamTransportConfig()
  const response = await fetchUpstreamWithLifecycle(
    `${baseUrl}/responses`,
    {
      method: "POST",
      headers,
      body,
    },
    {
      clientSignal,
      headersTimeoutMs: transportConfig.headersTimeoutMs,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
    },
  )

  logCopilotRateLimits(response.headers)
  return response
}

const streamOversizedCompactionOverHttp = async function* (
  baseUrl: string,
  payload: ResponsesPayload,
  headers: Record<string, string>,
  clientSignal?: AbortSignal,
): ResponsesStream {
  const body = JSON.stringify(payload)
  if (Buffer.byteLength(body) > COPILOT_RESPONSES_HTTP_MAX_REQUEST_BYTES) {
    yield createResponsesErrorServerSentEventChunk(
      "The Responses compaction request exceeds the 32.0 MiB GitHub Copilot HTTP limit. Reduce the conversation size or start a new one.",
      "context_length_exceeded",
    )
    return
  }

  const response = await fetchHttpResponses(
    baseUrl,
    body,
    headers,
    clientSignal,
  )
  if (response.ok) {
    yield* createResponsesHttpEventStream(response)
    return
  }

  const text = (await response.text()).trim()
  let error: { code?: unknown; message?: unknown } | undefined
  try {
    error = (JSON.parse(text) as { error?: typeof error } | null)?.error
  } catch {
    // Copilot may return a plain-text error.
  }
  const message =
    (typeof error?.message === "string" && error.message.trim())
    || text
    || `Copilot Responses compaction failed (HTTP ${response.status}).`
  // HTTP 413 always indicates an oversized request; normalize unknown upstream
  // codes (such as request_too_large) so clients do not retry the same body.
  const code =
    response.status === 413 ?
      "context_length_exceeded"
    : (typeof error?.code === "string" && error.code.trim()) || null
  consola.warn(
    `Copilot Responses compaction HTTP fallback failed (status=${response.status}, code=${code ?? "none"})`,
  )
  yield createResponsesErrorServerSentEventChunk(message, code)
}

type ResponsesWebSocketPayload = ResponsesPayload & {
  type: "response.create"
  initiator: "agent" | "user"
}

type ResponsesWebSocketRequest =
  PooledWebSocketRequest<ResponsesWebSocketPayload>

export const prepareResponsesWebSocketRequest = (
  payload: ResponsesPayload,
  preparedHeaders: Record<string, string>,
  options: {
    baseUrl?: string
    requestId: string
    subagentMarker?: SubagentMarker | null
  },
): ResponsesWebSocketRequest => {
  const initiator = getResponsesWebSocketInitiator(preparedHeaders)

  return {
    headers: copilotWebSocketHeaders(preparedHeaders),
    poolKey: buildResponsesWebSocketPoolKey(payload, options),
    payload: buildResponsesWebSocketPayload(payload, initiator),
    url: buildResponsesWebSocketUrl(options.baseUrl ?? copilotBaseUrl(state)),
  }
}

export const buildResponsesWebSocketPoolKey = (
  payload: ResponsesPayload,
  {
    requestId,
    subagentMarker,
  }: {
    requestId: string
    subagentMarker?: SubagentMarker | null
  },
): string => {
  const tokenFingerprint =
    state.copilotToken ?
      createHash("sha256").update(state.copilotToken).digest("hex").slice(0, 16)
    : "missing-token"
  const subagentKey =
    subagentMarker ?
      [
        subagentMarker.session_id,
        subagentMarker.agent_id,
        subagentMarker.agent_type,
      ].join(":")
    : "main"

  return [tokenFingerprint, payload.model, requestId, subagentKey]
    .map(encodePoolKeyPart)
    .join("|")
}

export const getResponsesWebSocketInitiator = (
  preparedHeaders: Record<string, string>,
): "agent" | "user" => {
  const initiator = getHeaderValue(preparedHeaders, "x-initiator")
  return initiator?.toLowerCase() === "agent" ? "agent" : "user"
}

const createPooledResponsesWebSocketStream = (
  request: ResponsesWebSocketRequest,
  clientSignal?: AbortSignal,
  continuationSession?: string,
  httpFallback?: () => ResponsesStream,
): ResponsesStream =>
  createResponsesSafeStream(
    streamWithCompactionHttpFallback(
      createContinuableResponsesWebSocketStream(
        request,
        {
          ...getResponsesWebSocketOptions(),
        },
        {
          sessionId: continuationSession,
          clientSignal,
        },
      ),
      clientSignal,
      httpFallback,
    ),
    { signal: clientSignal },
  )

const getResponsesWebSocketOptions = () => {
  const transportConfig = getUpstreamTransportConfig()
  return {
    createChunk: createResponsesWebSocketStreamChunk,
    maxBufferedBytes: transportConfig.websocketMaxBufferedBytes,
    maxBufferedMessages: transportConfig.websocketMaxBufferedMessages,
    maxMessageBytes: COPILOT_RESPONSES_WEBSOCKET_MAX_MESSAGE_BYTES,
    getTerminalDisposition: getResponsesStreamTerminalDisposition,
    openErrorMessage: "Failed to create responses websocket",
    openTimeoutMs: transportConfig.websocketOpenTimeoutMs,
    poolIdleTimeoutMs: transportConfig.websocketPoolIdleTimeoutMs,
    streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
    streamErrorMessage:
      "Upstream connection lost, Responses websocket stream error",
    terminalChunkMissingMessage:
      "Responses websocket ended without a terminal response, retry your request.",
  }
}

const streamWithCompactionHttpFallback = async function* (
  source: ResponsesStream,
  clientSignal?: AbortSignal,
  httpFallback?: () => ResponsesStream,
): ResponsesStream {
  if (clientSignal?.aborted) return
  try {
    yield* source
  } catch (error) {
    if (
      !httpFallback
      || !(error instanceof ResponsesWebSocketMessageTooLargeError)
    ) {
      throw error
    }
    if (clientSignal?.aborted) return
    consola.debug(
      "Copilot Responses compaction message exceeded WebSocket limit; falling back to HTTP",
    )
    yield* httpFallback()
  }
}

export const buildResponsesWebSocketPayload = (
  payload: ResponsesPayload,
  initiator: "agent" | "user",
): ResponsesWebSocketPayload => {
  const websocketPayload: ResponsesWebSocketPayload = {
    ...payload,
    type: "response.create",
    initiator,
  }

  delete websocketPayload.stream
  delete websocketPayload["background"]
  delete websocketPayload.service_tier

  return websocketPayload
}

export const buildResponsesWebSocketUrl = (baseUrl: string): string => {
  return createWebSocketUrl(`${baseUrl.replace(/\/+$/u, "")}/responses`)
}

const getHeaderValue = (
  headers: Record<string, string>,
  headerName: string,
): string | undefined => {
  const normalizedHeaderName = headerName.toLowerCase()
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === normalizedHeaderName,
  )

  return match?.[1]
}

export const createResponsesWebSocketStreamChunk = (
  data: string,
): ResponsesStreamChunk =>
  decodeResponsesWebSocketChunk(data, normalizeCopilotWebSocketEvent)

const normalizeCopilotWebSocketEvent = (
  event: ResponseStreamEvent,
): boolean => {
  if (event.type === "response.completed") {
    logCopilotQuotaSnapshots(event.copilot_quota_snapshots)
  }
  if (event.type !== "error" || !event.error) return false

  consola.warn("Copilot responses websocket stream error:", event.error)
  event.code = event.error.code
  event.message = event.error.message
  return true
}
