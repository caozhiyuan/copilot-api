import consola from "consola"

import {
  getExtraPromptForModel,
  getReasoningEffortForModel,
} from "~/lib/config"
import {
  type ResponsesPayload,
  type ResponseInputCompaction,
  type ResponseInputContent,
  type ResponseInputImage,
  type ResponseInputItem,
  type ResponseInputMessage,
  type ResponseInputReasoning,
  type ResponseInputText,
  type ResponsesResult,
  type ResponseOutputContentBlock,
  type ResponseOutputCompaction,
  type ResponseOutputFunctionCall,
  type ResponseOutputItem,
  type ResponseOutputReasoning,
  type ResponseReasoningBlock,
  type ResponseOutputRefusal,
  type ResponseOutputText,
  type ResponseFunctionToolCallItem,
  type ResponseFunctionCallOutputItem,
  type Tool,
  type ToolChoiceFunction,
  type ToolChoiceOptions,
} from "~/services/copilot/create-responses"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicResponse,
  type AnthropicImageBlock,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "./anthropic-types"

const MESSAGE_TYPE = "message"
const COMPACTION_SIGNATURE_PREFIX = "cm1#"
const COMPACTION_SIGNATURE_SEPARATOR = "@"

export const THINKING_TEXT = "Thinking..."

export const translateAnthropicMessagesToResponsesPayload = (
  payload: AnthropicMessagesPayload,
): ResponsesPayload => {
  const input: Array<ResponseInputItem> = []
  const applyPhase = shouldApplyPhase(payload.model)

  for (const message of payload.messages) {
    input.push(...translateMessage(message, payload.model, applyPhase))
  }

  const translatedTools = convertAnthropicTools(payload.tools)
  const toolChoice = convertAnthropicToolChoice(payload.tool_choice)

  const { safetyIdentifier, promptCacheKey } = parseUserId(
    payload.metadata?.user_id,
  )

  const responsesPayload: ResponsesPayload = {
    model: payload.model,
    input,
    instructions: translateSystemPrompt(payload.system, payload.model),
    temperature: 1, // reasoning high temperature fixed to 1
    top_p: payload.top_p ?? null,
    max_output_tokens: Math.max(payload.max_tokens, 12800),
    tools: translatedTools,
    tool_choice: toolChoice,
    metadata: payload.metadata ? { ...payload.metadata } : null,
    safety_identifier: safetyIdentifier,
    prompt_cache_key: promptCacheKey,
    stream: payload.stream ?? null,
    store: false,
    parallel_tool_calls: true,
    reasoning: {
      effort: getReasoningEffortForModel(payload.model),
      summary: "detailed",
    },
    include: ["reasoning.encrypted_content"],
  }

  return responsesPayload
}

type CompactionCarrier = {
  id: string
  encrypted_content: string
}

export const encodeCompactionCarrierSignature = (
  compaction: CompactionCarrier,
): string => {
  return `${COMPACTION_SIGNATURE_PREFIX}${compaction.encrypted_content}${COMPACTION_SIGNATURE_SEPARATOR}${compaction.id}`
}

export const decodeCompactionCarrierSignature = (
  signature: string,
): CompactionCarrier | undefined => {
  if (signature.startsWith(COMPACTION_SIGNATURE_PREFIX)) {
    const raw = signature.slice(COMPACTION_SIGNATURE_PREFIX.length)
    const separatorIndex = raw.indexOf(COMPACTION_SIGNATURE_SEPARATOR)

    if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
      return undefined
    }

    const encrypted_content = raw.slice(0, separatorIndex)
    const id = raw.slice(separatorIndex + 1)

    if (!encrypted_content) {
      return undefined
    }

    return {
      id,
      encrypted_content,
    }
  }

  return undefined
}

const translateMessage = (
  message: AnthropicMessage,
  model: string,
  applyPhase: boolean,
): Array<ResponseInputItem> => {
  if (message.role === "user") {
    return translateUserMessage(message)
  }

  return translateAssistantMessage(message, model, applyPhase)
}

const translateUserMessage = (
  message: AnthropicUserMessage,
): Array<ResponseInputItem> => {
  if (typeof message.content === "string") {
    return [createMessage("user", message.content)]
  }

  if (!Array.isArray(message.content)) {
    return []
  }

  const items: Array<ResponseInputItem> = []
  const pendingContent: Array<ResponseInputContent> = []

  for (const block of message.content) {
    if (block.type === "tool_result") {
      flushPendingContent(pendingContent, items, { role: "user" })
      items.push(createFunctionCallOutput(block))
      continue
    }

    const converted = translateUserContentBlock(block)
    if (converted) {
      pendingContent.push(converted)
    }
  }

  flushPendingContent(pendingContent, items, { role: "user" })

  return items
}

const translateAssistantMessage = (
  message: AnthropicAssistantMessage,
  model: string,
  applyPhase: boolean,
): Array<ResponseInputItem> => {
  const assistantPhase = resolveAssistantPhase(
    model,
    message.content,
    applyPhase,
  )

  if (typeof message.content === "string") {
    return [createMessage("assistant", message.content, assistantPhase)]
  }

  if (!Array.isArray(message.content)) {
    return []
  }

  const items: Array<ResponseInputItem> = []
  const pendingContent: Array<ResponseInputContent> = []

  for (const block of message.content) {
    if (block.type === "tool_use") {
      flushPendingContent(pendingContent, items, {
        role: "assistant",
        phase: assistantPhase,
      })
      items.push(createFunctionToolCall(block))
      continue
    }

    if (block.type === "thinking" && block.signature) {
      const compactionContent = createCompactionContent(block)
      if (compactionContent) {
        flushPendingContent(pendingContent, items, {
          role: "assistant",
          phase: assistantPhase,
        })
        items.push(compactionContent)
        continue
      }

      if (block.signature.includes("@")) {
        flushPendingContent(pendingContent, items, {
          role: "assistant",
          phase: assistantPhase,
        })
        items.push(createReasoningContent(block))
        continue
      }
    }

    const converted = translateAssistantContentBlock(block)
    if (converted) {
      pendingContent.push(converted)
    }
  }

  flushPendingContent(pendingContent, items, {
    role: "assistant",
    phase: assistantPhase,
  })

  return items
}

const translateUserContentBlock = (
  block: AnthropicUserContentBlock,
): ResponseInputContent | undefined => {
  switch (block.type) {
    case "text": {
      return createTextContent(block.text)
    }
    case "image": {
      return createImageContent(block)
    }
    default: {
      return undefined
    }
  }
}

const translateAssistantContentBlock = (
  block: AnthropicAssistantContentBlock,
): ResponseInputContent | undefined => {
  switch (block.type) {
    case "text": {
      return createOutPutTextContent(block.text)
    }
    default: {
      return undefined
    }
  }
}

const flushPendingContent = (
  pendingContent: Array<ResponseInputContent>,
  target: Array<ResponseInputItem>,
  message: Pick<ResponseInputMessage, "role" | "phase">,
) => {
  if (pendingContent.length === 0) {
    return
  }

  const messageContent = [...pendingContent]

  target.push(createMessage(message.role, messageContent, message.phase))
  pendingContent.length = 0
}

const createMessage = (
  role: ResponseInputMessage["role"],
  content: string | Array<ResponseInputContent>,
  phase?: ResponseInputMessage["phase"],
): ResponseInputMessage => ({
  type: MESSAGE_TYPE,
  role,
  content,
  ...(role === "assistant" && phase ? { phase } : {}),
})

const resolveAssistantPhase = (
  _model: string,
  content: AnthropicAssistantMessage["content"],
  applyPhase: boolean,
): ResponseInputMessage["phase"] | undefined => {
  if (!applyPhase) {
    return undefined
  }

  if (typeof content === "string") {
    return "final_answer"
  }

  if (!Array.isArray(content)) {
    return undefined
  }

  const hasText = content.some((block) => block.type === "text")
  if (!hasText) {
    return undefined
  }

  const hasToolUse = content.some((block) => block.type === "tool_use")
  return hasToolUse ? "commentary" : "final_answer"
}

const shouldApplyPhase = (model: string): boolean => {
  const extraPrompt = getExtraPromptForModel(model)
  return extraPrompt.includes("## Intermediary updates")
}

const createTextContent = (text: string): ResponseInputText => ({
  type: "input_text",
  text,
})

const createOutPutTextContent = (text: string): ResponseInputText => ({
  type: "output_text",
  text,
})

const createImageContent = (
  block: AnthropicImageBlock,
): ResponseInputImage => ({
  type: "input_image",
  image_url: `data:${block.source.media_type};base64,${block.source.data}`,
  detail: "auto",
})

const createReasoningContent = (
  block: AnthropicThinkingBlock,
): ResponseInputReasoning => {
  // align with vscode-copilot-chat extractThinkingData, should add id, otherwise it will cause miss cache occasionally —— the usage input cached tokens to be 0
  // https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/node/responsesApi.ts#L162
  // when use in codex cli, reasoning id is empty, so it will cause miss cache occasionally
  const { encryptedContent, id } = parseReasoningSignature(block.signature)
  const thinking = block.thinking === THINKING_TEXT ? "" : block.thinking
  return {
    id,
    type: "reasoning",
    summary: thinking ? [{ type: "summary_text", text: thinking }] : [],
    encrypted_content: encryptedContent,
  }
}

const createCompactionContent = (
  block: AnthropicThinkingBlock,
): ResponseInputCompaction | undefined => {
  const compaction = decodeCompactionCarrierSignature(block.signature)
  if (!compaction) {
    return undefined
  }

  return {
    id: compaction.id,
    type: "compaction",
    encrypted_content: compaction.encrypted_content,
  }
}

const parseReasoningSignature = (
  signature: string,
): { encryptedContent: string; id: string } => {
  const splitIndex = signature.lastIndexOf("@")

  if (splitIndex <= 0 || splitIndex === signature.length - 1) {
    return { encryptedContent: signature, id: "" }
  }

  return {
    encryptedContent: signature.slice(0, splitIndex),
    id: signature.slice(splitIndex + 1),
  }
}

const createFunctionToolCall = (
  block: AnthropicToolUseBlock,
): ResponseFunctionToolCallItem => ({
  type: "function_call",
  call_id: block.id,
  name: block.name,
  arguments: JSON.stringify(block.input),
  status: "completed",
})

const createFunctionCallOutput = (
  block: AnthropicToolResultBlock,
): ResponseFunctionCallOutputItem => ({
  type: "function_call_output",
  call_id: block.tool_use_id,
  output: convertToolResultContent(block.content),
  status: block.is_error ? "incomplete" : "completed",
})

const translateSystemPrompt = (
  system: string | Array<AnthropicTextBlock> | undefined,
  model: string,
): string | null => {
  if (!system) {
    return null
  }

  const extraPrompt = getExtraPromptForModel(model)

  if (typeof system === "string") {
    return system + extraPrompt
  }

  const text = system
    .map((block, index) => {
      if (index === 0) {
        return block.text + extraPrompt
      }
      return block.text
    })
    .join(" ")
  return text.length > 0 ? text : null
}

const convertAnthropicTools = (
  tools: Array<AnthropicTool> | undefined,
): Array<Tool> | null => {
  if (!tools || tools.length === 0) {
    return null
  }

  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    parameters: tool.input_schema,
    strict: false,
    ...(tool.description ? { description: tool.description } : {}),
  }))
}

const convertAnthropicToolChoice = (
  choice: AnthropicMessagesPayload["tool_choice"],
): ToolChoiceOptions | ToolChoiceFunction => {
  if (!choice) {
    return "auto"
  }

  switch (choice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      return choice.name ? { type: "function", name: choice.name } : "auto"
    }
    case "none": {
      return "none"
    }
    default: {
      return "auto"
    }
  }
}

export const translateResponsesResultToAnthropic = (
  response: ResponsesResult,
): AnthropicResponse => {
  const contentBlocks = mapOutputToAnthropicContent(response.output)
  const usage = mapResponsesUsage(response)
  let anthropicContent = fallbackContentBlocks(response.output_text)
  if (contentBlocks.length > 0) {
    anthropicContent = contentBlocks
  }

  const stopReason = mapResponsesStopReason(response)

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

const mapOutputToAnthropicContent = (
  output: Array<ResponseOutputItem>,
): Array<AnthropicAssistantContentBlock> => {
  const contentBlocks: Array<AnthropicAssistantContentBlock> = []

  for (const item of output) {
    switch (item.type) {
      case "reasoning": {
        const thinkingText = extractReasoningText(item)
        if (thinkingText.length > 0) {
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

const combineMessageTextContent = (
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

const extractReasoningText = (item: ResponseOutputReasoning): string => {
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

  // Compatible with opencode, it will filter out blocks where the thinking text is empty, so we add a default thinking text here
  if (!item.summary || item.summary.length === 0) {
    return THINKING_TEXT
  }

  collectFromBlocks(item.summary)

  return segments.join("").trim()
}

const createToolUseContentBlock = (
  call: ResponseOutputFunctionCall,
): AnthropicToolUseBlock | null => {
  const toolId = call.call_id
  if (!call.name || !toolId) {
    return null
  }

  const input = parseFunctionCallArguments(call.arguments)

  return {
    type: "tool_use",
    id: toolId,
    name: call.name,
    input,
  }
}

const createCompactionThinkingBlock = (
  item: ResponseOutputCompaction,
): AnthropicAssistantContentBlock | null => {
  if (!item.id || !item.encrypted_content) {
    return null
  }

  return {
    type: "thinking",
    thinking: THINKING_TEXT,
    signature: encodeCompactionCarrierSignature({
      id: item.id,
      encrypted_content: item.encrypted_content,
    }),
  }
}

const parseFunctionCallArguments = (
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

const fallbackContentBlocks = (
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

const mapResponsesStopReason = (
  response: ResponsesResult,
): AnthropicResponse["stop_reason"] => {
  const { status, incomplete_details: incompleteDetails } = response

  if (status === "completed") {
    if (response.output.some((item) => item.type === "function_call")) {
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

const mapResponsesUsage = (
  response: ResponsesResult,
): AnthropicResponse["usage"] => {
  const inputTokens = response.usage?.input_tokens ?? 0
  const outputTokens = response.usage?.output_tokens ?? 0
  const inputCachedTokens = response.usage?.input_tokens_details?.cached_tokens

  return {
    input_tokens: inputTokens - (inputCachedTokens ?? 0),
    output_tokens: outputTokens,
    ...(response.usage?.input_tokens_details?.cached_tokens !== undefined && {
      cache_read_input_tokens:
        response.usage.input_tokens_details.cached_tokens,
    }),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isResponseOutputText = (
  block: ResponseOutputContentBlock,
): block is ResponseOutputText =>
  isRecord(block)
  && "type" in block
  && (block as { type?: unknown }).type === "output_text"

const isResponseOutputRefusal = (
  block: ResponseOutputContentBlock,
): block is ResponseOutputRefusal =>
  isRecord(block)
  && "type" in block
  && (block as { type?: unknown }).type === "refusal"

const parseUserId = (
  userId: string | undefined,
): { safetyIdentifier: string | null; promptCacheKey: string | null } => {
  if (!userId || typeof userId !== "string") {
    return { safetyIdentifier: null, promptCacheKey: null }
  }

  // Parse safety_identifier: content between "user_" and "_account"
  const userMatch = userId.match(/user_([^_]+)_account/)
  const safetyIdentifier = userMatch ? userMatch[1] : null

  // Parse prompt_cache_key: content after "_session_"
  const sessionMatch = userId.match(/_session_(.+)$/)
  const promptCacheKey = sessionMatch ? sessionMatch[1] : null

  return { safetyIdentifier, promptCacheKey }
}

const convertToolResultContent = (
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>,
): string | Array<ResponseInputContent> => {
  if (typeof content === "string") {
    return content
  }

  if (Array.isArray(content)) {
    const result: Array<ResponseInputContent> = []
    for (const block of content) {
      switch (block.type) {
        case "text": {
          result.push(createTextContent(block.text))
          break
        }
        case "image": {
          result.push(createImageContent(block))
          break
        }
        default: {
          break
        }
      }
    }
    return result
  }

  return ""
}
