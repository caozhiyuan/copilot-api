import {
  CLAUDE_DEFERRED_TOOL_PLACEHOLDER_NAME,
  CLAUDE_TOOL_SEARCH_NAME,
  isBridgeToolSearchName,
  isDeferredToolName,
  listDeferredToolNames,
  normalizeToolSearchBridgeArguments,
  parseDeferredToolNames,
  parseMcpToolSearchSentinel,
  resolveResponsesToolSearchMode,
  selectDeferredToolsByNames,
  type ResponsesToolSearchMode,
} from "~/lib/tool-search"
import { HTTPError } from "~/lib/error"
import {
  getExtraPromptForModel,
  getReasoningEffortForModel,
  isGpt56OrAbove,
} from "~/lib/config"
import { getPromptCacheKey } from "~/lib/utils"
import {
  type ResponsesPayload,
  type ResponseInputCompaction,
  type ResponseInputContent,
  type ResponseInputFile,
  type ResponseInputImage,
  type ResponseInputItem,
  type ResponseInputMessage,
  type ResponseInputReasoning,
  type ResponseInputText,
  type ResponseFunctionToolCallItem,
  type ResponseFunctionCallOutputItem,
  type ResponseToolSearchCallItem,
  type ResponseToolSearchOutputItem,
  type FunctionTool,
  type Tool,
  type ToolChoiceFunction,
  type ToolChoiceOptions,
} from "~/lib/types/responses"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicDocumentBlock,
  type AnthropicImageBlock,
  type AnthropicInputMessage,
  type AnthropicMessagesPayload,
  type AnthropicSystemMessage,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultContentBlock,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "~/lib/types/anthropic"
import { normalizeToolSchema, THINKING_TEXT } from "../completions-translation"

import {
  decodeCompactionCarrierSignature,
  REASONING_SUMMARY_SEPARATOR_PATTERN,
} from "./shared"

export const MESSAGE_TYPE = "message"

export const resolveReasoningEffort = (payload: AnthropicMessagesPayload) =>
  payload.output_config?.effort ?? getReasoningEffortForModel(payload.model)

export const translateAnthropicMessagesToResponsesPayload = (
  payload: AnthropicMessagesPayload,
): ResponsesPayload => {
  const input: Array<ResponseInputItem> = []
  const applyPhase = shouldApplyPhase(payload.model)
  const toolSearchMode = resolveResponsesToolSearchMode({
    model: payload.model,
    tools: payload.tools,
  })
  const translationState: TranslationState = {
    originalTools: payload.tools ?? [],
    toolSearchMode,
    toolUseNameById: new Map(),
    loadedToolNames: new Set(),
    eagerToolNames: new Set(
      (payload.tools ?? [])
        .filter(
          (tool) =>
            !tool.defer_loading
            && tool.name !== CLAUDE_TOOL_SEARCH_NAME
            && !isBridgeToolSearchName(tool.name),
        )
        .map((tool) => tool.name),
    ),
  }

  for (const message of payload.messages) {
    input.push(
      ...translateMessage(message, payload.model, applyPhase, translationState),
    )
  }

  const hasOriginalTools =
    Array.isArray(payload.tools) && payload.tools.length > 0
  const translatedTools = convertAnthropicTools(payload.tools, toolSearchMode)
  const toolChoice = convertAnthropicToolChoice(
    payload.tool_choice,
    toolSearchMode,
  )

  const promptCacheKey = getPromptCacheKey()

  const responsesPayload: ResponsesPayload = {
    model: payload.model,
    input,
    instructions: translateSystemPrompt(payload.system, payload.model),
    temperature: 1, // reasoning high temperature fixed to 1
    top_p: payload.top_p ?? null,
    max_output_tokens: payload.max_tokens,
    tools: translatedTools,
    metadata: payload.metadata ? { ...payload.metadata } : null,
    //prompt_cache_retention: "24h",  not work in gpt-5.4
    stream: payload.stream ?? null,
    store: false,
    parallel_tool_calls: !payload.tool_choice?.disable_parallel_tool_use,
    reasoning: {
      effort: resolveReasoningEffort(payload),
      summary: payload.model.includes("grok") ? "concise" : "auto",
      context: isSupportAllTurns(payload) ? "all_turns" : "auto",
    },
    include: ["reasoning.encrypted_content"],
  }

  // Copilot /responses rejects tool_choice when no tools were translated.
  if (translatedTools && translatedTools.length > 0) {
    responsesPayload.tool_choice = toolChoice
  }

  if (hasOriginalTools) {
    responsesPayload.prompt_cache_key = promptCacheKey
  }

  // grok meatadata is not supported
  if (responsesPayload.model.includes("grok")) {
    delete responsesPayload.metadata
    delete responsesPayload.temperature
    delete responsesPayload.top_p
    // Match Grok Build: omit the output limit and use upstream defaults.
    delete responsesPayload.max_output_tokens
    if (responsesPayload.instructions) {
      input.unshift(createMessage("system", responsesPayload.instructions))
    }
    delete responsesPayload.instructions
  }

  return responsesPayload
}

export interface TranslationState {
  originalTools: Array<AnthropicTool>
  toolSearchMode: ResponsesToolSearchMode
  toolUseNameById: Map<string, string>
  loadedToolNames: Set<string>
  eagerToolNames: Set<string>
}

export const translateMessage = (
  message: AnthropicInputMessage,
  model: string,
  applyPhase: boolean,
  state: TranslationState,
): Array<ResponseInputItem> => {
  if (message.role === "user") {
    return translateUserMessage(message, state)
  }

  if (message.role === "system") {
    return translateSystemMessage(message)
  }

  return translateAssistantMessage(message, model, applyPhase, state)
}

export const translateSystemMessage = (
  message: AnthropicSystemMessage,
): Array<ResponseInputItem> => {
  if (typeof message.content === "string") {
    return message.content.length > 0 ?
        [createMessage("developer", message.content)]
      : []
  }

  const content = message.content
    .filter((block) => block.type === "text" && block.text.length > 0)
    .map((block) => createTextContent(block.text))
  return content.length > 0 ? [createMessage("developer", content)] : []
}

export const translateUserMessage = (
  message: AnthropicUserMessage,
  state: TranslationState,
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
      items.push(createToolCallOutput(block, state))
      continue
    }

    const converted = translateUserContentBlock(block)
    if (converted.length > 0) {
      pendingContent.push(...converted)
    }
  }

  flushPendingContent(pendingContent, items, { role: "user" })

  return items
}

export const translateAssistantMessage = (
  message: AnthropicAssistantMessage,
  model: string,
  applyPhase: boolean,
  state: TranslationState,
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
      state.toolUseNameById.set(block.id, block.name)
      flushPendingContent(pendingContent, items, {
        role: "assistant",
        phase: assistantPhase,
      })
      items.push(createToolCall(block, state))
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

export const translateUserContentBlock = (
  block: AnthropicUserContentBlock,
): Array<ResponseInputContent> => {
  switch (block.type) {
    case "text": {
      return [createTextContent(block.text)]
    }
    case "image": {
      return [createImageContent(block)]
    }
    case "document": {
      return [createFileContent(block)]
    }
    default: {
      return []
    }
  }
}

export const translateAssistantContentBlock = (
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

export const flushPendingContent = (
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

export const createMessage = (
  role: ResponseInputMessage["role"],
  content: string | Array<ResponseInputContent>,
  phase?: ResponseInputMessage["phase"],
): ResponseInputMessage => ({
  type: MESSAGE_TYPE,
  role,
  content,
  ...(role === "assistant" && phase ? { phase } : {}),
})

export const resolveAssistantPhase = (
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

export const shouldApplyPhase = (_model: string): boolean => {
  return true
}

export const createTextContent = (text: string): ResponseInputText => ({
  type: "input_text",
  text,
})

export const createOutPutTextContent = (text: string): ResponseInputText => ({
  type: "output_text",
  text,
})

export const createImageContent = (
  block: AnthropicImageBlock,
): ResponseInputImage => ({
  type: "input_image",
  image_url: `data:${block.source.media_type};base64,${block.source.data}`,
  detail: "auto",
})

export const createFileContent = (
  block: AnthropicDocumentBlock,
): ResponseInputFile => ({
  type: "input_file",
  file_data: `data:${block.source.media_type};base64,${block.source.data}`,
  filename: block.title ?? "document.pdf",
})

export const createReasoningContent = (
  block: AnthropicThinkingBlock,
): ResponseInputReasoning => {
  // align with vscode-copilot-chat extractThinkingData, should add id
  // https://github.com/microsoft/vscode/blob/1.128.0/extensions/copilot/src/platform/endpoint/node/responsesApi.ts#L651
  const { encryptedContent, id } = parseReasoningSignature(block.signature)
  const thinking = block.thinking === THINKING_TEXT ? "" : block.thinking

  return {
    id,
    type: "reasoning",
    summary: createReasoningSummary(thinking),
    encrypted_content: encryptedContent,
  }
}

export const createReasoningSummary = (
  thinking: string,
): ResponseInputReasoning["summary"] => {
  if (thinking.length === 0) {
    return []
  }

  if (!REASONING_SUMMARY_SEPARATOR_PATTERN.test(thinking)) {
    return [{ type: "summary_text", text: thinking }]
  }

  return thinking.split(REASONING_SUMMARY_SEPARATOR_PATTERN).map((text) => ({
    type: "summary_text",
    text,
  }))
}

export const createCompactionContent = (
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

export const parseReasoningSignature = (
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

export const createFunctionToolCall = (
  block: AnthropicToolUseBlock,
  state: TranslationState,
): ResponseFunctionToolCallItem => ({
  type: "function_call",
  call_id: block.id,
  name: block.name,
  arguments: JSON.stringify(block.input),
  status: "completed",
  ...((
    (state.toolSearchMode === "bridge" && isDeferredToolName(block.name))
    || (state.toolSearchMode === "native"
      && state.loadedToolNames.has(block.name))
  ) ?
    { namespace: block.name }
  : {}),
})

export const createToolSearchCall = (
  block: AnthropicToolUseBlock,
  mode: ResponsesToolSearchMode = "bridge",
): ResponseToolSearchCallItem => {
  let args = normalizeToolSearchBridgeArguments(block.input)
  if (mode === "native") {
    if (block.name === CLAUDE_TOOL_SEARCH_NAME) {
      args = block.input
    } else {
      const names = parseDeferredToolNames(args.names)
      args = {
        query: `select:${names.join(",")}`,
        max_results: Math.max(5, names.length),
      }
    }
  }
  return {
    type: "tool_search_call",
    call_id: block.id,
    arguments: args,
    execution: "client",
    status: "completed",
  }
}

export const createToolCall = (
  block: AnthropicToolUseBlock,
  state: TranslationState,
): ResponseFunctionToolCallItem | ResponseToolSearchCallItem => {
  if (
    (state.toolSearchMode === "native"
      && block.name === CLAUDE_TOOL_SEARCH_NAME)
    || (state.toolSearchMode !== "disabled"
      && isBridgeToolSearchName(block.name))
  ) {
    return createToolSearchCall(block, state.toolSearchMode)
  }

  return createFunctionToolCall(block, state)
}

export const createFunctionCallOutput = (
  block: AnthropicToolResultBlock,
): ResponseFunctionCallOutputItem => ({
  type: "function_call_output",
  call_id: block.tool_use_id,
  output: convertToolResultContent(block.content),
  status: block.is_error ? "incomplete" : "completed",
})

export const createToolCallOutput = (
  block: AnthropicToolResultBlock,
  state: TranslationState,
): ResponseFunctionCallOutputItem | ResponseToolSearchOutputItem => {
  const toolUseName = state.toolUseNameById.get(block.tool_use_id)
  if (
    state.toolSearchMode === "native"
    && (toolUseName === CLAUDE_TOOL_SEARCH_NAME
      || isBridgeToolSearchName(toolUseName ?? ""))
  ) {
    return createNativeToolSearchOutput(block, state)
  }
  if (
    state.toolSearchMode === "bridge"
    && isBridgeToolSearchName(toolUseName ?? "")
  ) {
    return createToolSearchOutput(block, state.originalTools)
  }

  return createFunctionCallOutput(block)
}

export const createNativeToolSearchOutput = (
  block: AnthropicToolResultBlock,
  state: TranslationState,
): ResponseToolSearchOutputItem => {
  const explicitReferences = extractToolReferenceNames(block.content)
  const referencedToolNames = uniqueToolNames(
    explicitReferences.length > 0 ?
      explicitReferences
    : (extractMcpToolSearchSentinel(block.content)?.names ?? []),
  )
  const tools: Array<FunctionTool> = []

  for (const toolName of referencedToolNames) {
    const converted = resolveNativeDeferredTool(toolName, state.originalTools)
    if (state.eagerToolNames.has(toolName)) continue

    if (state.loadedToolNames.has(toolName)) continue
    state.loadedToolNames.add(toolName)
    tools.push(converted)
  }

  return {
    type: "tool_search_output",
    call_id: block.tool_use_id,
    tools,
    execution: "client",
    status: block.is_error ? "incomplete" : "completed",
  }
}

export const resolveNativeDeferredTool = (
  toolName: string,
  originalTools: Array<AnthropicTool>,
): FunctionTool => {
  const matches = originalTools.filter((tool) => tool.name === toolName)
  const tool = matches[0]
  if (
    toolName !== CLAUDE_DEFERRED_TOOL_PLACEHOLDER_NAME
    && matches.length === 1
    && tool.input_schema
    && typeof tool.input_schema === "object"
    && !Array.isArray(tool.input_schema)
  ) {
    // Responses uses its own defer_loading flag for client-loaded functions.
    return { ...convertToolToFunction(tool), defer_loading: true }
  }

  throw createInvalidRequestError(
    `Tool reference '${toolName}' has no unambiguous tool definition`,
  )
}

export const createToolSearchOutput = (
  block: AnthropicToolResultBlock,
  originalTools: Array<AnthropicTool>,
): ResponseToolSearchOutputItem => {
  const referencedToolNames = resolveToolSearchReferencedToolNames(
    block.content,
    originalTools,
  )

  return {
    type: "tool_search_output",
    call_id: block.tool_use_id,
    tools: referencedToolNames.map((toolName) => ({
      ...convertToolToFunction(resolveDeferredTool(toolName, originalTools)),
      defer_loading: true,
    })),
    execution: "client",
    status: block.is_error ? "incomplete" : "completed",
  }
}

export const resolveToolSearchReferencedToolNames = (
  content: string | Array<AnthropicToolResultContentBlock>,
  originalTools: Array<AnthropicTool>,
): Array<string> => {
  const explicitReferences = extractToolReferenceNames(content)
  if (explicitReferences.length > 0) {
    return uniqueToolNames(explicitReferences)
  }

  const sentinel = extractMcpToolSearchSentinel(content)
  if (sentinel) {
    return selectDeferredToolsByNames(sentinel.names, originalTools).map(
      (tool) => tool.name,
    )
  }

  return []
}

export const extractToolReferenceNames = (
  content: string | Array<AnthropicToolResultContentBlock>,
): Array<string> => {
  if (!Array.isArray(content)) {
    return []
  }

  return content.flatMap((block) =>
    block.type === "tool_reference" ? [block.tool_name] : [],
  )
}

export const extractMcpToolSearchSentinel = (
  content: string | Array<AnthropicToolResultContentBlock>,
) => {
  if (typeof content === "string") {
    return parseMcpToolSearchSentinel(content)
  }

  for (const block of content) {
    if (block.type !== "text") {
      continue
    }

    const sentinel = parseMcpToolSearchSentinel(block.text)
    if (sentinel) {
      return sentinel
    }
  }

  return null
}

export const resolveDeferredTool = (
  toolName: string,
  originalTools: Array<AnthropicTool>,
): AnthropicTool => {
  const tool = originalTools.find((candidate) => candidate.name === toolName)
  if (tool && isDeferredToolName(tool.name)) {
    return tool
  }

  throw createInvalidRequestError(
    `Tool reference '${toolName}' has no corresponding deferred tool definition`,
  )
}

export const uniqueToolNames = (toolNames: Array<string>): Array<string> => [
  ...new Set(toolNames),
]

export const createInvalidRequestError = (message: string): HTTPError =>
  new HTTPError(
    message,
    new Response(
      JSON.stringify({
        error: {
          message,
          type: "invalid_request_error",
        },
      }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    ),
  )

export const translateSystemPrompt = (
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
        return block.text + "\n\n" + extraPrompt + "\n\n"
      }
      return block.text
    })
    .join(" ")
  return text.length > 0 ? text : null
}

export const convertAnthropicTools = (
  tools: Array<AnthropicTool> | undefined,
  toolSearchMode: ResponsesToolSearchMode,
): Array<Tool> | null => {
  if (!tools || tools.length === 0) {
    return null
  }

  const converted: Array<Tool> = []
  let addedToolSearch = false
  const searchableToolNames =
    toolSearchMode === "bridge" ? listDeferredToolNames(tools) : []

  for (const tool of tools) {
    if (toolSearchMode === "native") {
      if (tool.name === CLAUDE_TOOL_SEARCH_NAME) {
        if (!addedToolSearch) {
          converted.push(createNativeResponsesToolSearchDefinition(tool))
          addedToolSearch = true
        }
        continue
      }
      if (
        tool.name === CLAUDE_DEFERRED_TOOL_PLACEHOLDER_NAME
        || isBridgeToolSearchName(tool.name)
        || tool.defer_loading
      ) {
        continue
      }
    }

    if (isBridgeToolSearchName(tool.name)) {
      if (toolSearchMode === "bridge" && !addedToolSearch) {
        converted.push(createResponsesToolSearchDefinition(searchableToolNames))
        addedToolSearch = true
      }
      continue
    }

    if (toolSearchMode === "bridge" && isDeferredToolName(tool.name)) {
      continue
    }

    converted.push(convertToolToFunction(tool))
  }

  return converted
}

export const createNativeResponsesToolSearchDefinition = (
  tool: AnthropicTool,
): Tool => ({
  type: "tool_search",
  execution: "client",
  description:
    "Find and load deferred tools using Claude Code ToolSearch. Use select:<name> for exact names, or search with keywords. Available tool names are provided in the conversation.",
  parameters: normalizeToolSchema(tool.input_schema),
})

export const createResponsesToolSearchDefinition = (
  searchableToolNames: Array<string>,
): Tool => ({
  type: "tool_search",
  execution: "client",
  description:
    "Load deferred tools by exact name before using them. Return only the searchable tool names you need for the next step.",
  parameters: {
    type: "object",
    properties: {
      names: {
        type: "array",
        description: "Exact deferred tool names to load.",
        items: {
          type: "string",
          enum: searchableToolNames,
        },
        minItems: 1,
      },
    },
    required: ["names"],
    additionalProperties: false,
  },
})

export const convertToolToFunction = (tool: AnthropicTool): FunctionTool => ({
  type: "function",
  name: tool.name,
  parameters: normalizeToolSchema(tool.input_schema),
  strict: tool.strict ?? false,
  ...(tool.description ? { description: tool.description } : {}),
})

export const convertDeferredToolToNamespace = (tool: AnthropicTool): Tool => ({
  type: "namespace",
  name: tool.name,
  ...(tool.description ? { description: tool.description } : {}),
  tools: [
    {
      type: "function",
      name: tool.name,
      parameters: normalizeToolSchema(tool.input_schema),
      strict: tool.strict ?? false,
      defer_loading: true,
      ...(tool.description ? { description: tool.description } : {}),
    },
  ],
})

export const convertAnthropicToolChoice = (
  choice: AnthropicMessagesPayload["tool_choice"],
  toolSearchMode: ResponsesToolSearchMode,
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
      if (
        toolSearchMode !== "disabled"
        && choice.name
        && (isBridgeToolSearchName(choice.name)
          || (toolSearchMode === "native"
            && choice.name === CLAUDE_TOOL_SEARCH_NAME))
      ) {
        return "auto"
      }
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

export const convertToolResultContent = (
  content: string | Array<AnthropicToolResultContentBlock>,
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
        case "document": {
          result.push(createFileContent(block))
          break
        }
        case "tool_reference": {
          result.push(createTextContent(`Tool ${block.tool_name} loaded`))
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

export const isSupportAllTurns = (
  payload: AnthropicMessagesPayload,
): boolean => {
  if (
    payload.model === "gpt-5.4"
    || payload.model === "gpt-5.4-mini"
    || payload.model === "gpt-5.5"
  ) {
    return true
  }
  return isGpt56OrAbove(payload.model)
}
