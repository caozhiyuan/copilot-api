import consola from "consola"
import { events } from "fetch-event-stream"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export type MessagesStream = ReturnType<typeof events>
export type CreateMessagesReturn = AnthropicResponse | MessagesStream

export const createMessages = async (
  payload: AnthropicMessagesPayload,
  anthropicBetaHeader?: string,
  options?: {
    initiator?: "agent" | "user"
  },
): Promise<CreateMessagesReturn> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some((block) => block.type === "image"),
  )

  let isInitiateRequest = false
  const lastMessage = payload.messages.at(-1)
  if (lastMessage?.role === "user") {
    isInitiateRequest =
      Array.isArray(lastMessage.content) ?
        lastMessage.content.some((block) => block.type !== "tool_result")
      : true
  }
  const initiator = options?.initiator ?? (isInitiateRequest ? "user" : "agent")

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": initiator,
  }

  if (anthropicBetaHeader) {
    // align with vscode copilot extension anthropic-beta
    const filteredBeta = anthropicBetaHeader
      .split(",")
      .map((item) => item.trim())
      .filter(
        (item) =>
          item !== "claude-code-20250219" && !item.startsWith("context-1m-"),
      )
      .join(",")
    if (filteredBeta) {
      headers["anthropic-beta"] = filteredBeta
    }
  } else if (payload.thinking?.budget_tokens) {
    headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
  }

  const response = await fetch(`${copilotBaseUrl(state)}/v1/messages`, {
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
