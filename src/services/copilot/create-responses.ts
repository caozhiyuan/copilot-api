import consola from "consola"
import { createHash } from "node:crypto"

import type { SubagentMarker } from "~/lib/subagent"
import type { ResponsesStreamChunk } from "~/lib/responses-stream-event"
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
} from "~/lib/api-config"
import { COMPACT_REQUEST, type CompactType } from "~/lib/compact"
import {
  getUpstreamTransportConfig,
  isOutputEncryptedContentDisabled,
} from "~/lib/config"
import {
  logCopilotQuotaSnapshots,
  logCopilotRateLimits,
} from "~/lib/copilot-rate-limit"
import { HTTPError } from "~/lib/error"
import { getResponsesContinuationSession } from "~/lib/responses-continuation"
import { setPluginRequestActualModel } from "~/lib/request-context"
import { state } from "~/lib/state"
import { createWebSocketUrl } from "~/services/responses-websocket"
import { createContinuableResponsesWebSocketStream } from "~/services/responses-websocket-continuation"
import {
  createResponsesSafeStream,
  decodeResponsesWebSocketChunk,
  encodePoolKeyPart,
  getResponsesStreamTerminalDisposition,
} from "~/services/responses-websocket-helpers"
import { createResponsesHttpEventStream } from "~/services/responses-http"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"

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
  const upstreamPayload = omitUnsupportedCopilotInclude(payload)

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
): Promise<CreateResponsesReturn> => {
  const transportConfig = getUpstreamTransportConfig()
  const response = await fetchUpstreamWithLifecycle(
    `${copilotBaseUrl(state)}/responses`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
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
  clientSignal?: AbortSignal,
  continuationSession?: string,
): ResponsesStream =>
  createResponsesSafeStream(
    createClientPreflightStream(
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
    ),
  )

const getResponsesWebSocketOptions = () => {
  const transportConfig = getUpstreamTransportConfig()
  return {
    createChunk: createResponsesWebSocketStreamChunk,
    maxBufferedBytes: transportConfig.websocketMaxBufferedBytes,
    maxBufferedMessages: transportConfig.websocketMaxBufferedMessages,
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
