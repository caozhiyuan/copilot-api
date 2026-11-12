import consola from "consola"

import {
  BRIDGE_TOOL_SEARCH_NAME,
  formatToolSearchArguments,
} from "~/lib/tool-search"

import {
  type ResponsesResult,
  type ResponseOutputContentBlock,
  type ResponseOutputCompaction,
  type ResponseOutputFunctionCall,
  type ResponseOutputToolSearchCall,
  type ResponseOutputItem,
  type ResponseOutputReasoning,
  type ResponseReasoningBlock,
  type ResponseOutputRefusal,
  type ResponseOutputText,
} from "~/lib/types/responses"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicResponse,
  type AnthropicToolUseBlock,
} from "~/lib/types/anthropic"

import {
  encodeCompactionCarrierSignature,
  REASONING_SUMMARY_SEPARATOR,
} from "./shared"

export interface ResponsesToAnthropicOptions {
  toolSearchName?: string
  hasToolCall?: boolean
}

export const translateResponsesResultToAnthropic = (
  response: ResponsesResult,
  options?: ResponsesToAnthropicOptions,
): AnthropicResponse => {
  const contentBlocks = mapOutputToAnthropicContent(response.output, options)
  const usage = mapResponsesUsage(response)
  let anthropicContent = fallbackContentBlocks(response.output_text)
  if (contentBlocks.length > 0) {
    anthropicContent = contentBlocks
  }

  const stopReason = mapResponsesStopReason(response, options)

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    content: anthropicContent,
    model: response.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  }
}

export const mapOutputToAnthropicContent = (
  output: Array<ResponseOutputItem>,
  options?: ResponsesToAnthropicOptions,
): Array<AnthropicAssistantContentBlock> => {
  const contentBlocks: Array<AnthropicAssistantContentBlock> = []
  if (!output) {
    output = []
  }
  for (const item of output) {
    switch (item.type) {
      case "reasoning": {
        const thinkingText = extractReasoningText(item)
        if (thinkingText.length > 0 || (item.id && item.encrypted_content)) {
          contentBlocks.push({
            type: "thinking",
            thinking: thinkingText,
            signature: (item.encrypted_content ?? "") + "@" + item.id,
          })
        }
        break
      }
      case "function_call": {
        const toolUseBlock = createToolUseContentBlock(item)
        if (toolUseBlock) {
          contentBlocks.push(toolUseBlock)
        }
        break
      }
      case "tool_search_call": {
        const toolUseBlock = createToolSearchUseContentBlock(
          item,
          options?.toolSearchName,
        )
        if (toolUseBlock) {
          contentBlocks.push(toolUseBlock)
        }
        break
      }
      case "tool_search_output": {
        break
      }
      case "message": {
        const combinedText = combineMessageTextContent(item.content)
        if (combinedText.length > 0) {
          contentBlocks.push({ type: "text", text: combinedText })
        }
        break
      }
      case "compaction": {
        const compactionBlock = createCompactionThinkingBlock(item)
        if (compactionBlock) {
          contentBlocks.push(compactionBlock)
        }
        break
      }
      default: {
        // Future compatibility for unrecognized output item types.
        const combinedText = combineMessageTextContent(
          (item as { content?: Array<ResponseOutputContentBlock> }).content,
        )
        if (combinedText.length > 0) {
          contentBlocks.push({ type: "text", text: combinedText })
        }
      }
    }
  }

  return contentBlocks
}

export const combineMessageTextContent = (
  content: Array<ResponseOutputContentBlock> | undefined,
): string => {
  if (!Array.isArray(content)) {
    return ""
  }

  let aggregated = ""

  for (const block of content) {
    if (isResponseOutputText(block)) {
      aggregated += block.text
      continue
    }

    if (isResponseOutputRefusal(block)) {
      aggregated += block.refusal
      continue
    }

    if (typeof (block as { text?: unknown }).text === "string") {
      aggregated += (block as { text: string }).text
      continue
    }

    if (typeof (block as { reasoning?: unknown }).reasoning === "string") {
      aggregated += (block as { reasoning: string }).reasoning
      continue
    }
  }

  return aggregated
}

export const extractReasoningText = (item: ResponseOutputReasoning): string => {
  const segments: Array<string> = []

  const collectFromBlocks = (blocks?: Array<ResponseReasoningBlock>) => {
    if (!Array.isArray(blocks)) {
      return
    }

    for (const block of blocks) {
      if (typeof block.text === "string") {
        segments.push(block.text)
        continue
      }
    }
  }

  collectFromBlocks(item.summary)

  return segments.join(REASONING_SUMMARY_SEPARATOR).trim()
}

export const createToolUseContentBlock = (
  call: ResponseOutputFunctionCall,
): AnthropicToolUseBlock | null => {
  const toolId = call.call_id
  const toolName = resolveToolUseName(call)
  if (!toolName || !toolId) {
    return null
  }

  const input = parseFunctionCallArguments(call.arguments)

  return {
    type: "tool_use",
    id: toolId,
    name: toolName,
    input,
  }
}

export const createToolSearchUseContentBlock = (
  call: ResponseOutputToolSearchCall,
  toolSearchName = BRIDGE_TOOL_SEARCH_NAME,
): AnthropicToolUseBlock | null => {
  const toolId = call.call_id
  if (!toolId) {
    return null
  }

  return {
    type: "tool_use",
    id: toolId,
    name: toolSearchName,
    input: parseToolSearchArguments(call.arguments, toolSearchName),
  }
}

export const resolveToolUseName = (
  call: Pick<ResponseOutputFunctionCall, "name" | "namespace">,
): string => {
  if (typeof call.namespace === "string" && call.namespace.length > 0) {
    return call.namespace
  }

  return call.name
}

export const createCompactionThinkingBlock = (
  item: ResponseOutputCompaction,
): AnthropicAssistantContentBlock | null => {
  if (!item.id || !item.encrypted_content) {
    return null
  }

  return {
    type: "thinking",
    thinking: "",
    signature: encodeCompactionCarrierSignature({
      id: item.id,
      encrypted_content: item.encrypted_content,
    }),
  }
}

export const parseFunctionCallArguments = (
  rawArguments: string,
): Record<string, unknown> => {
  if (typeof rawArguments !== "string" || rawArguments.trim().length === 0) {
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(rawArguments)

    if (Array.isArray(parsed)) {
      return { arguments: parsed }
    }

    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>
    }
  } catch (error) {
    consola.warn("Failed to parse function call arguments", {
      error,
      rawArguments,
    })
  }

  return { raw_arguments: rawArguments }
}

export const parseToolSearchArguments = (
  argumentsValue: Record<string, unknown> | string,
  toolSearchName = BRIDGE_TOOL_SEARCH_NAME,
): Record<string, unknown> => {
  return formatToolSearchArguments(argumentsValue, toolSearchName)
}

export const fallbackContentBlocks = (
  outputText: string,
): Array<AnthropicAssistantContentBlock> => {
  if (!outputText) {
    return []
  }

  return [
    {
      type: "text",
      text: outputText,
    },
  ]
}

export const mapResponsesStopReason = (
  response: ResponsesResult,
  options?: ResponsesToAnthropicOptions,
): AnthropicResponse["stop_reason"] => {
  const { status, incomplete_details: incompleteDetails } = response

  if (status === "completed") {
    if (!response.output || response.output.length === 0) {
      return options?.hasToolCall ? "tool_use" : "end_turn"
    }

    if (
      response.output.some(
        (item) =>
          item.type === "function_call" || item.type === "tool_search_call",
      )
    ) {
      return "tool_use"
    }
    return "end_turn"
  }

  if (status === "incomplete") {
    if (incompleteDetails?.reason === "max_output_tokens") {
      return "max_tokens"
    }
    if (incompleteDetails?.reason === "content_filter") {
      return "end_turn"
    }
  }

  return null
}

export const mapResponsesUsage = (
  response: ResponsesResult,
): AnthropicResponse["usage"] => {
  const inputTokens = response.usage?.input_tokens ?? 0
  const outputTokens = response.usage?.output_tokens ?? 0
  const inputCachedTokens = response.usage?.input_tokens_details?.cached_tokens
  const cacheWriteTokens =
    response.usage?.input_tokens_details?.cache_write_tokens

  return {
    input_tokens:
      inputTokens - (inputCachedTokens ?? 0) - (cacheWriteTokens ?? 0),
    output_tokens: outputTokens,
    ...(inputCachedTokens !== undefined && {
      cache_read_input_tokens: inputCachedTokens,
    }),
    ...(cacheWriteTokens !== undefined && {
      cache_creation_input_tokens: cacheWriteTokens,
    }),
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export const isResponseOutputText = (
  block: ResponseOutputContentBlock,
): block is ResponseOutputText =>
  isRecord(block)
  && "type" in block
  && (block as { type?: unknown }).type === "output_text"

export const isResponseOutputRefusal = (
  block: ResponseOutputContentBlock,
): block is ResponseOutputRefusal =>
  isRecord(block)
  && "type" in block
  && (block as { type?: unknown }).type === "refusal"
