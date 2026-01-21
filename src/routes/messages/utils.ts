import type { ConsolaInstance } from "consola"
import type { Context } from "hono"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { getAliasTargetSet } from "~/lib/config"
import { getRequestHistoryStore } from "~/lib/request-history"
import { getTokenCount } from "~/lib/tokenizer"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
} from "./anthropic-types"

export function mapOpenAIStopReasonToAnthropic(
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): AnthropicResponse["stop_reason"] {
  if (finishReason === null) {
    return null
  }
  const stopReasonMap = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "end_turn",
  } as const
  return stopReasonMap[finishReason]
}

const mergeContentWithText = (
  toolResult: AnthropicToolResultBlock,
  textBlock: AnthropicTextBlock,
): AnthropicToolResultBlock => {
  if (typeof toolResult.content === "string") {
    return {
      ...toolResult,
      content: `${toolResult.content}\n\n${textBlock.text}`,
    }
  }
  return {
    ...toolResult,
    content: [...toolResult.content, textBlock],
  }
}

const mergeContentWithTexts = (
  toolResult: AnthropicToolResultBlock,
  textBlocks: Array<AnthropicTextBlock>,
): AnthropicToolResultBlock => {
  if (typeof toolResult.content === "string") {
    const appendedTexts = textBlocks.map((tb) => tb.text).join("\n\n")
    return {
      ...toolResult,
      content: `${toolResult.content}\n\n${appendedTexts}`,
    }
  }
  return { ...toolResult, content: [...toolResult.content, ...textBlocks] }
}

const mergeToolResult = (
  toolResults: Array<AnthropicToolResultBlock>,
  textBlocks: Array<AnthropicTextBlock>,
): Array<AnthropicToolResultBlock> => {
  if (toolResults.length === textBlocks.length) {
    return toolResults.map((toolResult, index) =>
      mergeContentWithText(toolResult, textBlocks[index]),
    )
  }

  const lastIndex = toolResults.length - 1
  return toolResults.map((toolResult, index) =>
    index === lastIndex ?
      mergeContentWithTexts(toolResult, textBlocks)
    : toolResult,
  )
}

export const mergeToolResultForClaude = (
  anthropicPayload: AnthropicMessagesPayload,
): void => {
  for (const msg of anthropicPayload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const toolResults: Array<AnthropicToolResultBlock> = []
    const textBlocks: Array<AnthropicTextBlock> = []
    let valid = true

    for (const block of msg.content) {
      if (block.type === "tool_result") {
        toolResults.push(block)
      } else if (block.type === "text") {
        textBlocks.push(block)
      } else {
        valid = false
        break
      }
    }

    if (!valid || toolResults.length === 0 || textBlocks.length === 0) continue

    msg.content = mergeToolResult(toolResults, textBlocks)
  }
}

export const estimateInputTokens = async (
  payload: ChatCompletionsPayload,
  selectedModel: Model,
  logger: Pick<ConsolaInstance, "warn">,
): Promise<number | undefined> => {
  try {
    const tokenCount = await getTokenCount(payload, selectedModel)
    return tokenCount.input
  } catch (error) {
    logger.warn("Failed to estimate input tokens for message_start", error)
    return undefined
  }
}

type SelectionFailureReason = "MODEL_NOT_SUPPORTED" | "NO_QUOTA" | "NO_ACCOUNTS"

type SelectionFailure = {
  ok: false
  reason: SelectionFailureReason
}

type SelectionFailureContext = {
  c: Context
  store: ReturnType<typeof getRequestHistoryStore>
  requestId: string
  startedAtMs: number
  method: string
  path: string
  streamRequested: boolean
  clientModel: string
  clientIp?: string
  clientIpSource?: string
  userAgent?: string
  userId?: string
  safetyIdentifier?: string
  promptCacheKey?: string
  initiator?: "agent" | "user"
  selection: SelectionFailure
}

export const isWarmupProbeRequest = (
  payload: AnthropicMessagesPayload,
): boolean => {
  const lastMsg = payload.messages.at(-1)
  if (!lastMsg || lastMsg.role !== "user" || !Array.isArray(lastMsg.content)) {
    return false
  }

  const lastBlock = lastMsg.content.at(-1)
  if (!lastBlock || lastBlock.type !== "text") {
    return false
  }

  const text = lastBlock.text.trim().toLowerCase()
  return text === "warmup" && lastBlock.cache_control?.type === "ephemeral"
}

export const handleSelectionFailure = (
  context: SelectionFailureContext,
): Response => {
  const {
    c,
    store,
    requestId,
    startedAtMs,
    method,
    path,
    streamRequested,
    clientModel,
    clientIp,
    clientIpSource,
    userAgent,
    userId,
    safetyIdentifier,
    promptCacheKey,
    initiator,
    selection,
  } = context
  const finishedAtMs = Date.now()

  store.insert({
    requestId,
    startedAtMs,
    finishedAtMs,
    durationMs: finishedAtMs - startedAtMs,
    method,
    path,
    stream: streamRequested,
    clientModel,
    clientIp,
    clientIpSource,
    userAgent,
    userId,
    safetyIdentifier,
    promptCacheKey,
    initiator,
    httpStatus: selection.reason === "MODEL_NOT_SUPPORTED" ? 400 : 429,
    selectionFailureReason: selection.reason,
  })

  if (selection.reason === "MODEL_NOT_SUPPORTED") {
    return c.json(
      {
        error: {
          message: `Model "${clientModel}" is not available for any configured account.`,
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  return c.json(
    {
      error: {
        message:
          "All accounts have exhausted their quota. Please wait for quota refresh or add additional accounts.",
        type: "rate_limit_error",
      },
    },
    429,
  )
}

export const maybeBlockOriginalModelName = (
  context: Omit<SelectionFailureContext, "selection">,
): Response | null => {
  const blockedTargets = getAliasTargetSet()
  if (!blockedTargets.has(context.clientModel.toLowerCase())) {
    return null
  }

  return handleSelectionFailure({
    ...context,
    selection: { ok: false, reason: "MODEL_NOT_SUPPORTED" },
  })
}
