import consola from "consola"
import { events } from "fetch-event-stream"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/lib/types/chat-completions"

import {
  copilotBaseUrl,
  copilotHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "~/lib/api-config"
import { getUpstreamTransportConfig } from "~/lib/config"
import { logCopilotRateLimits } from "~/lib/copilot-rate-limit"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  options: {
    clientSignal?: AbortSignal
    subagentMarker?: SubagentMarker | null
    requestId: string
    sessionId?: string
    compactType?: CompactType
    initiator?: "agent" | "user"
  },
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for x-initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  // Refactor `isAgentCall` logic to check only the last message in the history rather than any message. This prevents valid user messages from being incorrectly flagged as agent calls due to previous assistant history, ensuring proper credit consumption for multi-turn conversations.
  let isAgentCall = false
  if (payload.messages.length > 0) {
    const lastMessage = payload.messages.at(-1)
    if (lastMessage) {
      isAgentCall = ["assistant", "tool"].includes(lastMessage.role)
    }
  }

  // Build headers and add x-initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, options.requestId, enableVision),
    "x-initiator": options.initiator ?? (isAgentCall ? "agent" : "user"),
  }

  prepareInteractionHeaders(
    options.sessionId,
    Boolean(options.subagentMarker),
    headers,
  )

  prepareForCompact(headers, options.compactType)

  consola.log(`<-- model: ${payload.model}`)

  const transportConfig = getUpstreamTransportConfig()
  const response = await fetchUpstreamWithLifecycle(
    `${copilotBaseUrl(state)}/chat/completions`,
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

  logCopilotRateLimits(response.headers)

  if (!response.ok) {
    consola.error("Failed to create chat completions", response)
    throw new HTTPError("Failed to create chat completions", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}
