import type { ToolContentSupportType } from "~/lib/config"
import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type TextPart,
  type Tool,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicDocumentBlock,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultContentBlock,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

// Compatible with opencode, it will filter out blocks where the thinking text is empty, so we need add a default thinking text
export const THINKING_TEXT = "Thinking..."
export const RICH_TOOL_RESULT_MOVED_TEXT =
  "Rich tool result content was moved to a user message because this upstream does not support it in tool messages."
const COPILOT_TOOL_CONTENT_SUPPORT_TYPE: Array<ToolContentSupportType> = [
  "array",
  "image",
]

interface TranslationCapabilities {
  supportPdf: boolean
  toolContentSupportType: Array<ToolContentSupportType>
}

interface ToolContentSupport {
  array: boolean
  image: boolean
  pdf: boolean
}

interface ToolResultMessages {
  movedUserMessage?: Message
  toolMessage: Message
}

interface TranslateToOpenAIOptions {
  supportPdf?: boolean
  toolContentSupportType?: Array<ToolContentSupportType>
}

type MappableContentBlock =
  | AnthropicUserContentBlock
  | AnthropicAssistantContentBlock
  | AnthropicToolResultContentBlock

// Payload translation
export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
  options: TranslateToOpenAIOptions = {},
): ChatCompletionsPayload {
  const modelId = payload.model
  const model = state.models?.data.find((m) => m.id === modelId)
  const thinkingBudget = getThinkingBudget(payload, model)
  const capabilities = {
    supportPdf: options.supportPdf ?? false,
    toolContentSupportType:
      options.toolContentSupportType ?? COPILOT_TOOL_CONTENT_SUPPORT_TYPE,
  }
  return {
    model: modelId,
    messages: translateAnthropicMessagesToOpenAI(
      payload,
      modelId,
      capabilities,
    ),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id,
    tools: translateAnthropicToolsToOpenAI(payload.tools),
    tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice),
    thinking_budget: thinkingBudget,
  }
}

function getThinkingBudget(
  payload: AnthropicMessagesPayload,
  model: Model | undefined,
): number | undefined {
  const thinking = payload.thinking
  if (model && thinking) {
    const maxThinkingBudget = Math.min(
      model.capabilities.supports.max_thinking_budget ?? 0,
      (model.capabilities.limits.max_output_tokens ?? 0) - 1,
    )
    thinking.budget_tokens ??= maxThinkingBudget
    if (maxThinkingBudget > 0) {
      const budgetTokens = Math.min(thinking.budget_tokens, maxThinkingBudget)
      return Math.max(
        budgetTokens,
        model.capabilities.supports.min_thinking_budget ?? 1024,
      )
    }
  }
  return undefined
}

function translateAnthropicMessagesToOpenAI(
  payload: AnthropicMessagesPayload,
  modelId: string,
  capabilities: TranslationCapabilities,
): Array<Message> {
  const systemMessages = handleSystemPrompt(payload.system)
  const otherMessages = (payload.messages as Array<AnthropicMessage>).flatMap(
    (message) =>
      message.role === "user" ?
        handleUserMessage(message, capabilities)
      : handleAssistantMessage(message, modelId, capabilities),
  )
  return [...systemMessages, ...otherMessages]
}

function handleSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system }]
  } else {
    const systemText = system
      .map((block) => {
        return block.text
      })
      .join("\n\n")
    return [{ role: "system", content: systemText }]
  }
}

function handleUserMessage(
  message: AnthropicUserMessage,
  capabilities: TranslationCapabilities,
): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === "tool_result",
    )
    const otherBlocks = message.content.filter(
      (block) => block.type !== "tool_result",
    )

    // Tool results must come first to maintain protocol: tool_use -> tool_result -> user
    const movedToolResultUserMessages: Array<Message> = []
    for (const block of toolResultBlocks) {
      const result = handleToolResultBlock(block, capabilities)
      newMessages.push(result.toolMessage)
      if (result.movedUserMessage) {
        movedToolResultUserMessages.push(result.movedUserMessage)
      }
    }
    newMessages.push(...movedToolResultUserMessages)

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: "user",
        content: mapContent(otherBlocks, {
          supportPdf: capabilities.supportPdf,
        }),
      })
    }
  } else {
    newMessages.push({
      role: "user",
      content: mapContent(message.content),
    })
  }

  return newMessages
}

function handleToolResultBlock(
  block: AnthropicToolResultBlock,
  capabilities: TranslationCapabilities,
): ToolResultMessages {
  if (typeof block.content === "string") {
    return {
      toolMessage: createToolMessage(block.tool_use_id, block.content),
    }
  }

  if (!Array.isArray(block.content)) {
    return {
      toolMessage: createToolMessage(block.tool_use_id, ""),
    }
  }

  const support = getToolContentSupport(capabilities)
  const hasImage = block.content.some((block) => block.type === "image")
  const hasDocument = block.content.some((block) => block.type === "document")
  const content = mapContent(block.content, {
    supportPdf: capabilities.supportPdf,
  })

  const hasPdfFile = hasDocument && capabilities.supportPdf
  const shouldMoveImageToUserMessage = hasImage && !support.image
  const shouldMovePdfToUserMessage = hasPdfFile && !support.pdf
  if (shouldMoveImageToUserMessage || shouldMovePdfToUserMessage) {
    return {
      movedUserMessage: createToolResultUserMessage(
        block,
        capabilities.supportPdf,
      ),
      toolMessage: createToolMessage(
        block.tool_use_id,
        getTextToolContent(content) || RICH_TOOL_RESULT_MOVED_TEXT,
      ),
    }
  }

  const hasRichContent = hasImage || hasPdfFile
  if (support.array || hasRichContent) {
    return {
      toolMessage: createToolMessage(block.tool_use_id, content),
    }
  }

  return {
    toolMessage: createToolMessage(
      block.tool_use_id,
      getTextToolContent(content),
    ),
  }
}

function getTextToolContent(content: Message["content"]): string {
  if (!Array.isArray(content)) {
    return content ?? ""
  }

  return content
    .flatMap((part) =>
      part.type === "text" && part.text.length > 0 ? [part.text] : [],
    )
    .join("\n")
}

function getToolContentSupport(
  capabilities: TranslationCapabilities,
): ToolContentSupport {
  return {
    array: capabilities.toolContentSupportType.includes("array"),
    image: capabilities.toolContentSupportType.includes("image"),
    pdf:
      capabilities.supportPdf
      && capabilities.toolContentSupportType.includes("pdf"),
  }
}

function createToolMessage(
  toolCallId: string,
  content: Message["content"],
): Message {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content,
  }
}

function createToolResultUserMessage(
  block: AnthropicToolResultBlock,
  supportPdf: boolean,
): Message {
  const prefix: TextPart = {
    type: "text",
    text: `Tool result for ${block.tool_use_id}:`,
  }
  const content = mapContent(block.content, {
    supportPdf,
  })
  if (Array.isArray(content)) {
    return {
      role: "user",
      content: [prefix, ...content],
    }
  }

  return {
    role: "user",
    content: [prefix, { type: "text", text: content ?? "" }],
  }
}

function handleAssistantMessage(
  message: AnthropicAssistantMessage,
  modelId: string,
  capabilities: TranslationCapabilities,
): Array<Message> {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: "assistant",
        content: mapContent(message.content),
      },
    ]
  }

  const toolUseBlocks = message.content.filter(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use",
  )

  let thinkingBlocks = message.content.filter(
    (block): block is AnthropicThinkingBlock => block.type === "thinking",
  )

  if (modelId.startsWith("claude")) {
    thinkingBlocks = thinkingBlocks.filter(
      (b) =>
        b.thinking
        && b.thinking !== THINKING_TEXT
        && b.signature
        // gpt signature has @ in it, so filter those out for claude models
        && !b.signature.includes("@"),
    )
  }

  const thinkingContents = thinkingBlocks
    .filter((b) => b.thinking && b.thinking !== THINKING_TEXT)
    .map((b) => b.thinking)

  const allThinkingContent =
    thinkingContents.length > 0 ? thinkingContents.join("\n\n") : undefined

  const signature = thinkingBlocks.find((b) => b.signature)?.signature

  return toolUseBlocks.length > 0 ?
      [
        {
          role: "assistant",
          content: mapContent(message.content, {
            supportPdf: capabilities.supportPdf,
          }),
          reasoning_text: allThinkingContent,
          reasoning_opaque: signature,
          tool_calls: toolUseBlocks.map((toolUse) => ({
            id: toolUse.id,
            type: "function",
            function: {
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input),
            },
          })),
        },
      ]
    : [
        {
          role: "assistant",
          content: mapContent(message.content, {
            supportPdf: capabilities.supportPdf,
          }),
          reasoning_text: allThinkingContent,
          reasoning_opaque: signature,
        },
      ]
}

function mapContent(
  content: string | Array<MappableContentBlock>,
  options: { supportPdf?: boolean } = {},
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text })
        break
      }
      case "image": {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })
        break
      }
      case "document": {
        contentParts.push(
          options.supportPdf ?
            createDocumentFilePart(block)
          : createDocumentTextPart(),
        )
        break
      }
      case "tool_reference": {
        contentParts.push({
          type: "text",
          text: `Tool ${block.tool_name} loaded`,
        })
        break
      }
      // No default
    }
  }
  if (contentParts.length === 0) {
    return ""
  }
  return contentParts
}

function createDocumentTextPart(): TextPart {
  return {
    type: "text",
    text: "PDF/document content is not supported by this Chat Completions upstream. Use the available text extracted from the document.",
  }
}

function createDocumentFilePart(block: AnthropicDocumentBlock): ContentPart {
  return {
    type: "file",
    file: {
      file_data: `data:${block.source.media_type};base64,${block.source.data}`,
      filename: block.title ?? "document.pdf",
    },
  }
}

function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
): Array<Tool> | undefined {
  if (!anthropicTools) {
    return undefined
  }
  return anthropicTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeToolSchema(tool.input_schema),
    },
  }))
}

/**
 * Ensures `type: "object"` schema has a `properties` field.
 * OpenAI's API rejects object schemas without it.
 */
export const normalizeToolSchema = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  if (schema.type === "object" && !schema.properties) {
    return { ...schema, properties: {} }
  }
  return schema
}

function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] {
  if (!anthropicToolChoice) {
    return undefined
  }

  switch (anthropicToolChoice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      if (anthropicToolChoice.name) {
        return {
          type: "function",
          function: { name: anthropicToolChoice.name },
        }
      }
      return undefined
    }
    case "none": {
      return "none"
    }
    default: {
      return undefined
    }
  }
}

// Response translation

export function translateToAnthropic(
  response: ChatCompletionResponse,
): AnthropicResponse {
  // Merge content from all choices
  const assistantContentBlocks: Array<AnthropicAssistantContentBlock> = []
  let stopReason = response.choices[0]?.finish_reason ?? null

  // Process all choices to extract text and tool use blocks
  for (const choice of response.choices) {
    const textBlocks = getAnthropicTextBlocks(choice.message.content)
    const thinkBlocks = getAnthropicThinkBlocks(
      getOpenAIReasoningText(choice.message),
      choice.message.reasoning_opaque,
    )
    const toolUseBlocks = getAnthropicToolUseBlocks(choice.message.tool_calls)

    assistantContentBlocks.push(...thinkBlocks, ...textBlocks, ...toolUseBlocks)

    // Use the finish_reason from the first choice, or prioritize tool_calls
    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason
    }
  }

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: assistantContentBlocks,
    stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
    stop_sequence: null,
    usage: mapOpenAIChatCompletionUsage(response),
  }
}

function mapOpenAIChatCompletionUsage(
  response: ChatCompletionResponse,
): AnthropicResponse["usage"] {
  const promptDetails = response.usage?.prompt_tokens_details
  const promptTokens = response.usage?.prompt_tokens ?? 0
  const cachedTokens = promptDetails?.cached_tokens ?? 0
  const usage: AnthropicResponse["usage"] = {
    input_tokens: Math.max(0, promptTokens - cachedTokens),
    output_tokens: response.usage?.completion_tokens ?? 0,
  }

  if (promptDetails?.cached_tokens !== undefined) {
    usage.cache_read_input_tokens = cachedTokens
  }

  return usage
}

function getOpenAIReasoningText(message: {
  reasoning_content?: string | null
  reasoning_text?: string | null
}): string | null | undefined {
  return message.reasoning_text ?? message.reasoning_content
}

function getAnthropicTextBlocks(
  messageContent: Message["content"],
): Array<AnthropicTextBlock> {
  if (typeof messageContent === "string" && messageContent.length > 0) {
    return [{ type: "text", text: messageContent }]
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => ({ type: "text", text: part.text }))
  }

  return []
}

function getAnthropicThinkBlocks(
  reasoningText: string | null | undefined,
  reasoningOpaque: string | null | undefined,
): Array<AnthropicThinkingBlock> {
  if (reasoningText && reasoningText.length > 0) {
    return [
      {
        type: "thinking",
        thinking: reasoningText,
        signature: reasoningOpaque || "",
      },
    ]
  }
  if (reasoningOpaque && reasoningOpaque.length > 0) {
    return [
      {
        type: "thinking",
        thinking: THINKING_TEXT, // Compatible with opencode, it will filter out blocks where the thinking text is empty, so we add a default thinking text here
        signature: reasoningOpaque,
      },
    ]
  }
  return []
}

function getAnthropicToolUseBlocks(
  toolCalls: Array<ToolCall> | undefined,
): Array<AnthropicToolUseBlock> {
  if (!toolCalls) {
    return []
  }
  return toolCalls.map((toolCall) => ({
    type: "tool_use",
    id: toolCall.id,
    name: toolCall.function.name,
    input: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
  }))
}
