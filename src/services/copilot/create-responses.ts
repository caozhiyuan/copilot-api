import consola from "consola"
import { events } from "fetch-event-stream"
import { createHash } from "node:crypto"

import type { SubagentMarker } from "~/lib/subagent"
import type {
  CreateResponsesReturn,
  ResponsesPayload,
  ResponsesResult,
  ResponsesStream,
  ResponsesTransport,
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
import { getResponsesTransportConfig } from "~/lib/config"
import {
  logCopilotQuotaSnapshots,
  logCopilotRateLimits,
  type CopilotQuotaSnapshot,
} from "~/lib/copilot-rate-limit"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import {
  createPooledWebSocketStream,
  createWebSocketUrl,
} from "~/services/responses-websocket"
import {
  createResponsesSafeStream,
  encodePoolKeyPart,
  isTerminalResponsesStreamChunk,
} from "~/services/responses-websocket-helpers"
import { fetchResponsesWithLifecycle } from "~/services/responses-http"

interface ResponsesRequestOptions {
  vision: boolean
  initiator: "agent" | "user"
  subagentMarker?: SubagentMarker | null
  requestId: string
  sessionId?: string
  compactType?: CompactType
  transport?: ResponsesTransport
  signal?: AbortSignal
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
    signal,
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

  consola.log(`<-- model: ${payload.model}`)

  const effectiveTransport =
    compactType === COMPACT_REQUEST ? "http" : transport

  if (payload.stream === true && effectiveTransport === "websocket") {
    const websocketRequest = prepareResponsesWebSocketRequest(
      payload,
      headers,
      {
        requestId,
        signal,
        subagentMarker,
      },
    )
    const stream = createPooledResponsesWebSocketStream(websocketRequest)
    return stream
  }

  return await createHttpResponses(payload, headers, signal)
}

const createHttpResponses = async (
  payload: ResponsesPayload,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<CreateResponsesReturn> => {
  const transportConfig = getResponsesTransportConfig()
  const response = await fetchResponsesWithLifecycle(
    `${copilotBaseUrl(state)}/responses`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
    {
      headersTimeoutMs: transportConfig.headersTimeoutMs,
      signal,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
    },
  )

  logCopilotRateLimits(response.headers)

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return createResponsesSafeStream(events(response), { signal })
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
    signal?: AbortSignal
    subagentMarker?: SubagentMarker | null
  },
): ResponsesWebSocketRequest => {
  const initiator = getResponsesWebSocketInitiator(preparedHeaders)

  return {
    headers: copilotWebSocketHeaders(preparedHeaders),
    poolKey: buildResponsesWebSocketPoolKey(payload, options),
    payload: buildResponsesWebSocketPayload(payload, initiator),
    signal: options.signal,
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
): ResponsesStream => {
  const transportConfig = getResponsesTransportConfig()
  return createResponsesSafeStream(
    createPooledWebSocketStream(request, {
      createChunk: createResponsesWebSocketStreamChunk,
      maxBufferedBytes: transportConfig.websocketMaxBufferedBytes,
      maxBufferedMessages: transportConfig.websocketMaxBufferedMessages,
      isTerminalChunk: isTerminalResponsesStreamChunk,
      openErrorMessage: "Failed to create responses websocket",
      openTimeoutMs: transportConfig.websocketOpenTimeoutMs,
      poolIdleTimeoutMs: transportConfig.websocketPoolIdleTimeoutMs,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
      streamErrorMessage: "Responses websocket stream error",
      terminalChunkMissingMessage:
        "Responses websocket ended without a terminal response",
    }),
    { signal: request.signal },
  )
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

const createResponsesWebSocketStreamChunk = (
  data: string,
): { data?: string; event?: string; id?: string } => {
  if (data === "[DONE]") {
    return { data }
  }

  try {
    const parsed = JSON.parse(data) as {
      copilot_quota_snapshots?: Record<string, CopilotQuotaSnapshot>
      id?: unknown
      type?: unknown
      error?: {
        code: string | null
        message: string
      }
      code?: string | null
      message?: string
    }
    if (parsed.type === "response.completed") {
      logCopilotQuotaSnapshots(parsed.copilot_quota_snapshots)
    }
    if (parsed.type === "error" && parsed.error) {
      consola.warn("Copilot responses websocket stream error:", parsed.error)
      parsed.code = parsed.error.code
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
