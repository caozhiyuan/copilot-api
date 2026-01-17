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
  anthropicBeta: string | undefined,
  anthropicPayload: AnthropicMessagesPayload,
): void => {
  if (!anthropicBeta) return

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
