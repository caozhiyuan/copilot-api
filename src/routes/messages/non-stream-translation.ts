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
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

// Compatible with opencode, it will filter out blocks where the thinking text is empty, so we need add a default thinking text
export const THINKING_TEXT = "Thinking..."

// Payload translation
export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
): ChatCompletionsPayload {
  const modelId = translateModelName(payload.model)
  const model = state.models?.data.find((m) => m.id === modelId)
  const thinkingBudget = getThinkingBudget(payload, model)
  return {
    model: modelId,
    messages: translateAnthropicMessagesToOpenAI(
      payload,
      modelId,
      thinkingBudget,
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
    if (maxThinkingBudget > 0 && thinking.budget_tokens !== undefined) {
      const budgetTokens = Math.min(thinking.budget_tokens, maxThinkingBudget)
      return Math.max(
        budgetTokens,
        model.capabilities.supports.min_thinking_budget ?? 1024,
      )
    }
  }
  return undefined
}

function translateModelName(model: string): string {
  // Subagent requests use a specific model number which Copilot doesn't support
  if (model.startsWith("claude-sonnet-4-")) {
    return model.replace(/^claude-sonnet-4-.*/, "claude-sonnet-4")
  } else if (model.startsWith("claude-opus-4-")) {
    return model.replace(/^claude-opus-4-.*/, "claude-opus-4")
  }
  return model
}

function translateAnthropicMessagesToOpenAI(
  payload: AnthropicMessagesPayload,
  modelId: string,
  thinkingBudget: number | undefined,
): Array<Message> {
  const systemMessages = handleSystemPrompt(
    payload.system,
    modelId,
    thinkingBudget,
  )
  const otherMessages = payload.messages.flatMap((message) =>
    message.role === "user" ?
      handleUserMessage(message)
    : handleAssistantMessage(message, modelId),
  )
  if (modelId.startsWith("claude") && thinkingBudget) {
    const reminder =
      "<system-reminder>you MUST follow interleaved_thinking_protocol</system-reminder>"
    const firstUserIndex = otherMessages.findIndex((m) => m.role === "user")
    if (firstUserIndex !== -1) {
      const userMessage = otherMessages[firstUserIndex]
      if (typeof userMessage.content === "string") {
        userMessage.content = reminder + "\n\n" + userMessage.content
      } else if (Array.isArray(userMessage.content)) {
        userMessage.content = [
          { type: "text", text: reminder },
          ...userMessage.content,
        ] as Array<ContentPart>
      }
    }
  }
  return [...systemMessages, ...otherMessages]
}

function handleSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
  modelId: string,
  thinkingBudget: number | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  let extraPrompt = ""
  if (modelId.startsWith("claude") && thinkingBudget) {
    extraPrompt = `
<interleaved_thinking_protocol>
ABSOLUTE REQUIREMENT - NON-NEGOTIABLE:
The current thinking_mode is interleaved, Whenever you have the result of a function call, think carefully , MUST output a thinking block
RULES:
Tool result → thinking block (ALWAYS, no exceptions)
This is NOT optional - it is a hard requirement
The thinking block must contain substantive reasoning (minimum 3-5 sentences)
Think about: what the results mean, what to do next, how to answer the user
NEVER skip this step, even if the result seems simple or obvious
</interleaved_thinking_protocol>`
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system + extraPrompt }]
  } else {
    const systemText = system
      .map((block, index) => {
        if (index === 0) {
          return block.text + extraPrompt
        }
        return block.text
      })
      .join("\n\n")
    return [{ role: "system", content: systemText }]
  }
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
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
    for (const block of toolResultBlocks) {
      newMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: mapContent(block.content),
      })
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: "user",
        content: mapContent(otherBlocks),
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

function handleAssistantMessage(
  message: AnthropicAssistantMessage,
  modelId: string,
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
          content: mapContent(message.content),
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
          content: mapContent(message.content),
          reasoning_text: allThinkingContent,
          reasoning_opaque: signature,
        },
      ]
}

function mapContent(
  content:
    | string
    | Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>,
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }

  const hasImage = content.some((block) => block.type === "image")
  if (!hasImage) {
    return content
      .filter((block): block is AnthropicTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n\n")
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
      // No default
    }
  }
  return contentParts
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
      parameters: tool.input_schema,
    },
  }))
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
      choice.message.reasoning_text,
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
    usage: {
      input_tokens:
        (response.usage?.prompt_tokens ?? 0)
        - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: response.usage?.completion_tokens ?? 0,
      ...(response.usage?.prompt_tokens_details?.cached_tokens
        !== undefined && {
        cache_read_input_tokens:
          response.usage.prompt_tokens_details.cached_tokens,
      }),
    },
  }
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
