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
  createResponsesSafeStream,
  decodeResponsesWebSocketChunk,
  encodePoolKeyPart,
  getResponsesStreamTerminalDisposition,
} from "~/services/responses-websocket-helpers"
import { createResponsesHttpEventStream } from "~/services/responses-http"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"

// Copilot answers a Responses WebSocket message above 16 MiB with a generic
// `internal_error`, while its HTTP endpoint accepts requests up to 32 MiB.
export const COPILOT_RESPONSES_WEBSOCKET_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
export const COPILOT_RESPONSES_HTTP_MAX_REQUEST_BYTES = 32 * 1024 * 1024
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
  }: ResponsesRequestOptions,
): Promise<CreateResponsesReturn> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

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
        requestId,
        subagentMarker,
      },
    )
    const stream = createPooledResponsesWebSocketStream(
      websocketRequest,
      clientSignal,
      getResponsesContinuationSession(),
      () =>
        createOversizedHttpResponses(upstreamPayload, headers, clientSignal),
    )
    return stream
  }

  return await createHttpResponses(upstreamPayload, headers, clientSignal)
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
  payload: ResponsesPayload,
  headers: Record<string, string>,
  clientSignal?: AbortSignal,
  body = JSON.stringify(payload),
): Promise<CreateResponsesReturn> => {
  const transportConfig = getUpstreamTransportConfig()
  const response = await fetchUpstreamWithLifecycle(
    `${copilotBaseUrl(state)}/responses`,
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

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return createResponsesSafeStream(createResponsesHttpEventStream(response))
  }

  return (await response.json()) as ResponsesResult
}

const createOversizedHttpResponses = async (
  payload: ResponsesPayload,
  headers: Record<string, string>,
  clientSignal?: AbortSignal,
): Promise<ResponsesStream> => {
  const body = JSON.stringify(payload)
  const requestBytes = Buffer.byteLength(body)
  if (requestBytes > COPILOT_RESPONSES_HTTP_MAX_REQUEST_BYTES) {
    throw new ResponsesWebSocketMessageTooLargeError(
      requestBytes,
      COPILOT_RESPONSES_HTTP_MAX_REQUEST_BYTES,
    )
  }

  consola.info(
    `Responses request is ${(requestBytes / (1024 * 1024)).toFixed(1)} MiB, above the Copilot WebSocket limit; sending it over HTTP`,
  )
  return (await createHttpResponses(
    payload,
    headers,
    clientSignal,
    body,
  )) as ResponsesStream
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
    requestId: string
    subagentMarker?: SubagentMarker | null
  },
): ResponsesWebSocketRequest => {
  const initiator = getResponsesWebSocketInitiator(preparedHeaders)

  return {
    headers: copilotWebSocketHeaders(preparedHeaders),
    poolKey: buildResponsesWebSocketPoolKey(payload, options),
    payload: buildResponsesWebSocketPayload(payload, initiator),
    url: buildResponsesWebSocketUrl(copilotBaseUrl(state)),
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
  clientSignal: AbortSignal | undefined,
  continuationSession: string | undefined,
  sendOverHttp: () => Promise<ResponsesStream>,
): ResponsesStream =>
  createResponsesSafeStream(
    createClientPreflightStream(
      sendOverHttpWhenTooLarge(
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
        sendOverHttp,
      ),
      clientSignal,
    ),
  )

// The WebSocket size check runs before the message is sent and before any
// chunk is yielded, so the same request can still go over HTTP.
const sendOverHttpWhenTooLarge = async function* (
  source: AsyncIterable<ResponsesStreamChunk>,
  sendOverHttp: () => Promise<ResponsesStream>,
): AsyncGenerator<ResponsesStreamChunk, void, unknown> {
  try {
    yield* source
  } catch (error) {
    if (!(error instanceof ResponsesWebSocketMessageTooLargeError)) throw error
    yield* await sendOverHttp()
  }
}

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

const createClientPreflightStream = async function* <T>(
  source: AsyncIterable<T>,
  clientSignal?: AbortSignal,
): AsyncGenerator<T, void, unknown> {
  if (clientSignal?.aborted) return
  yield* source
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
