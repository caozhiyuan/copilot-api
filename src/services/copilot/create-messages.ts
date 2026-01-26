import consola from "consola"
import { events } from "fetch-event-stream"

import type { AccountContext } from "~/lib/types/account"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { accountFromState } from "~/lib/state"

export const getMessagesInitiator = (
  payload: AnthropicMessagesPayload,
): "agent" | "user" => {
  const lastMessage = payload.messages.at(-1)
  if (!lastMessage || lastMessage.role !== "user") {
    return "agent"
  }

  if (!Array.isArray(lastMessage.content)) {
    return "user"
  }

  const hasNonToolResult = lastMessage.content.some(
    (block) => block.type !== "tool_result",
  )
  return hasNonToolResult ? "user" : "agent"
}

export type MessagesStream = ReturnType<typeof events>
export type CreateMessagesReturn = AnthropicResponse | MessagesStream

export const createMessages = async (
  payload: AnthropicMessagesPayload,
  account?: AccountContext,
  options?: {
    anthropicBetaHeader?: string
    upstreamRequestId?: string
  },
): Promise<CreateMessagesReturn> => {
  const ctx = account ?? accountFromState()
  if (!ctx.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some((block) => block.type === "image"),
  )

  const initiator = getMessagesInitiator(payload)

  const headers: Record<string, string> = {
    ...copilotHeaders(ctx, enableVision, options?.upstreamRequestId),
    "X-Initiator": initiator,
  }

  if (options?.anthropicBetaHeader) {
    headers["anthropic-beta"] = options.anthropicBetaHeader
  } else if (payload.thinking?.budget_tokens) {
    headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
  }

  const response = await fetch(`${copilotBaseUrl(ctx)}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error("Failed to create messages", response)
    throw new HTTPError("Failed to create messages", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as AnthropicResponse
}
