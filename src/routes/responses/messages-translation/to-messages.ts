import {
  getProviderModelConfig,
  resolveProviderModelsDevId,
} from "~/lib/provider-model-catalog"
import { findEndpointModel } from "~/lib/models"
import { getModelsDevModelMaxOutputTokens } from "~/lib/models-dev-cache"
import { getRawProviderConfig } from "~/lib/provider-config"
import { parseProviderModelAlias } from "~/lib/provider-model"
import type {
  AnthropicAssistantContentBlock,
  AnthropicAssistantMessage,
  AnthropicCacheControl,
  AnthropicDocumentBlock,
  AnthropicImageBlock,
  AnthropicInputMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicUserContentBlock,
  AnthropicUserMessage,
} from "~/lib/types/anthropic"
import type {
  ResponseInputAgentMessage,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseInputReasoning,
  ResponsesPayload,
} from "~/lib/types/responses"

import {
  buildOutputFormatInstruction,
  COMPACTION_REPLAY_PROMPT,
  MAX_DEVELOPER_PROMPTS,
  MESSAGES_BATCH_TOOL_CALL_TIPS,
  MESSAGES_COMPACTION_PROMPT,
  MESSAGES_TOOL_CALL_TIPS,
  ResponsesMessagesTranslationError,
  type MessagesToolDescriptor,
  type MessagesToolRegistry,
  type ResponsesInputNormalization,
  type ResponsesToMessagesTranslation,
} from "./constants"
import {
  getItemType,
  getOptionalStringField,
  getStringField,
  isRecord,
  parseDataUrl,
  parseFunctionArguments,
  requireStringField,
} from "./parse"
import {
  createMessagesToolDescriptor,
  createToolRegistry,
  findOriginalDescriptor,
  hasExecCommandTool,
} from "./tools"
import {
  decodeMessagesCompaction,
  resolveMetadataUserId,
  translateReasoningEffort,
} from "./to-responses"

export function translateResponsesToMessages(
  payload: ResponsesPayload,
  options: { model: string; publicModel?: string; toolCallTips?: boolean },
): ResponsesToMessagesTranslation {
  removeWebSearchTool(payload)
  const registry = createToolRegistry(payload, options.model)
  const normalized = normalizeResponsesInput(payload.input)
  const outputFormatInstruction = buildOutputFormatInstruction(
    payload.text?.format,
  )
  // The tips describe the code-mode `functions.exec` wrapper, so they are
  // wrong for clients that expose `exec_command` as a real tool.
  const toolCallTips =
    (options.toolCallTips ?? false) && !hasExecCommandTool(payload)
  const { messages, system } = translateInputToAnthropic(
    normalized.input,
    registry,
    payload.instructions,
    payload.input,
    toolCallTips,
  )

  if (toolCallTips && payload.parallel_tool_calls === false) {
    appendToolCallTips(system, MESSAGES_BATCH_TOOL_CALL_TIPS)
  }

  if (normalized.compaction) {
    messages.push({ role: "user", content: MESSAGES_COMPACTION_PROMPT })
  }

  if (messages.length === 0) {
    throw new ResponsesMessagesTranslationError(
      "Responses input must contain at least one translatable message",
    )
  }

  if (outputFormatInstruction) {
    messages.push({ role: "user", content: outputFormatInstruction })
  }

  applyEphemeralCacheControl(messages, system)

  const reasoningEffort = translateReasoningEffort(payload.reasoning?.effort)
  const metadataUserId = resolveMetadataUserId(payload)
  const messagesPayload: AnthropicMessagesPayload = {
    model: options.model,
    messages,
    // Codex does not send the catalog's max_output_tokens; Messages requires
    // an explicit max_tokens value, so resolve the default in the adapter.
    max_tokens: Math.max(
      1,
      payload.max_output_tokens ?? resolveDefaultMaxOutputTokens(options.model),
    ),
    stream: payload.stream ?? false,
    temperature: payload.temperature ?? undefined,
    top_p: payload.top_p ?? undefined,
    system: system.length > 0 ? system : undefined,
    tools:
      normalized.compaction || registry.tools.length > 0 ?
        registry.tools
      : undefined,
    tool_choice: translateToolChoice(payload.tool_choice, registry),
    ...(reasoningEffort ? { output_config: { effort: reasoningEffort } } : {}),
    ...((
      payload.service_tier === "auto"
      || payload.service_tier === "standard_only"
    ) ?
      { service_tier: payload.service_tier }
    : {}),
    ...(metadataUserId ? { metadata: { user_id: metadataUserId } } : {}),
  }

  if (
    payload.parallel_tool_calls != null
    && registry.tools.length > 0
    && messagesPayload.tool_choice?.type !== "none"
  ) {
    messagesPayload.tool_choice = {
      ...(messagesPayload.tool_choice ?? { type: "auto" }),
      disable_parallel_tool_use: !payload.parallel_tool_calls,
    }
  }

  return {
    compaction: normalized.compaction,
    messagesPayload,
    originalPayload: payload,
    publicModel: options.publicModel ?? payload.model,
    registry,
  }
}

export function resolveDefaultMaxOutputTokens(model: string): number {
  const alias = parseProviderModelAlias(model)
  const providerConfig = alias ? getRawProviderConfig(alias.provider) : null
  const catalogMaxOutputTokens =
    alias ?
      getModelsDevModelMaxOutputTokens(
        resolveProviderModelsDevId(alias.provider, providerConfig),
        alias.model,
      )
    : undefined
  const builtinModelConfig =
    alias ?
      getProviderModelConfig(alias.provider, alias.model, providerConfig)
    : undefined
  const tokenLimits =
    alias && (providerConfig || builtinModelConfig || catalogMaxOutputTokens) ?
      [
        providerConfig?.models?.[alias.model]?.maxOutputTokens,
        catalogMaxOutputTokens,
        builtinModelConfig?.maxOutputTokens,
      ]
    : [findEndpointModel(model)?.capabilities.limits.max_output_tokens]

  return (
    tokenLimits.find(
      (limit): limit is number =>
        typeof limit === "number" && Number.isInteger(limit) && limit > 0,
    ) ?? 32_000
  )
}

export function normalizeResponsesInput(
  input: ResponsesPayload["input"],
): ResponsesInputNormalization {
  if (!Array.isArray(input)) {
    return { compaction: false, input }
  }

  const triggerIndexes = input.flatMap((item, index) =>
    getItemType(item) === "compaction_trigger" ? [index] : [],
  )
  const compaction = triggerIndexes.length > 0
  if (
    triggerIndexes.length > 1
    || (compaction && triggerIndexes[0] !== input.length - 1)
  ) {
    throw new ResponsesMessagesTranslationError(
      "compaction_trigger must be the final Responses input item",
    )
  }

  const withoutTrigger = compaction ? input.slice(0, -1) : [...input]
  let latestCompactionIndex = -1
  for (let index = withoutTrigger.length - 1; index >= 0; index -= 1) {
    if (getItemType(withoutTrigger[index]) === "compaction") {
      latestCompactionIndex = index
      break
    }
  }

  if (latestCompactionIndex < 0) {
    return { compaction, input: withoutTrigger }
  }

  const carrier = withoutTrigger[latestCompactionIndex]
  const encryptedContent = getStringField(carrier, "encrypted_content")
  const summary =
    encryptedContent ? decodeMessagesCompaction(encryptedContent) : null
  if (!summary) {
    throw new ResponsesMessagesTranslationError(
      "This Messages-backed model cannot replay a compaction created by another Responses backend; start a new conversation or switch back to the original model",
    )
  }

  const replayMessage: ResponseInputMessage = {
    type: "message",
    role: "user",
    content: `${COMPACTION_REPLAY_PROMPT}${summary}`,
  }
  return {
    compaction,
    input: [replayMessage, ...withoutTrigger.slice(latestCompactionIndex + 1)],
  }
}

export function removeWebSearchTool(payload: ResponsesPayload): void {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((tool) => tool.type !== "web_search")
}

export function translateInputToAnthropic(
  input: string | Array<ResponseInputItem> | undefined,
  registry: MessagesToolRegistry,
  instructions: string | null | undefined,
  originalInput: ResponsesPayload["input"],
  toolCallTips: boolean,
): {
  messages: Array<AnthropicInputMessage>
  system: Array<AnthropicTextBlock>
} {
  const messages: Array<AnthropicInputMessage> = []
  const system: Array<AnthropicTextBlock> = []
  if (instructions?.trim()) {
    system.push({ type: "text", text: instructions })
  }
  appendDeveloperPrompts(system, originalInput)

  if (typeof input === "string") {
    messages.push({ role: "user", content: input })
  } else if (Array.isArray(input)) {
    translateInputItems(input, messages, system, registry)
  }
  if (toolCallTips) {
    appendToolCallTips(system)
  }
  return { messages, system }
}

export function appendToolCallTips(
  system: Array<AnthropicTextBlock>,
  tips = MESSAGES_TOOL_CALL_TIPS,
): void {
  const lastSystemBlock = system.at(-1)
  if (!lastSystemBlock) {
    system.push({ type: "text", text: tips })
    return
  }
  lastSystemBlock.text = `${lastSystemBlock.text}\n\n${tips}`
}

export function translateInputItems(
  input: Array<ResponseInputItem>,
  messages: Array<AnthropicInputMessage>,
  system: Array<AnthropicTextBlock>,
  registry: MessagesToolRegistry,
): void {
  let userMessageSeen = false
  for (const item of input) {
    const type = getItemType(item)
    switch (type) {
      case undefined:
      case "message": {
        translateInputMessage(item, messages, system, userMessageSeen)
        if (getStringField(item, "role") === "user") {
          userMessageSeen = true
        }
        break
      }
      case "agent_message": {
        translateInputAgentMessage(item as ResponseInputAgentMessage, messages)
        userMessageSeen = true
        break
      }
      case "reasoning": {
        translateInputReasoning(item as ResponseInputReasoning, messages)
        break
      }
      case "function_call": {
        translateInputToolCall(item, "function", messages, registry)
        break
      }
      case "custom_tool_call": {
        translateInputToolCall(item, "custom", messages, registry)
        break
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const injectedKind = appendCodexPageContext(item, messages)
        if (injectedKind) {
          if (injectedKind === "delegation") userMessageSeen = true
          break
        }
        appendUserBlock(messages, {
          type: "tool_result",
          tool_use_id: requireStringField(item, "call_id", type),
          content: translateToolResultContent(
            (item as Record<string, unknown>).output,
            `${type}.output`,
          ),
          is_error: getStringField(item, "status") === "incomplete",
        })
        break
      }
      case "additional_tools":
      case "web_search_call": {
        break
      }
      default: {
        throw new ResponsesMessagesTranslationError(
          `Responses Messages fallback does not support input item type '${type}'`,
        )
      }
    }
  }
}

const CODEX_INJECTED_AGENT_OUTPUT_NAMES = new Set([
  "browser_tabs",
  "codex_apps_artifact_outline",
  "codex_apps_artifact_platform",
  "codex_apps_open_page",
  "codex_apps_page_task_chat_reference",
  "codex_code_review_current_pull_request",
  "codex_git_state",
  "ide_context",
  "latex_document",
])

const CODEX_INJECTED_APP_OUTPUT_NAMES = new Set([
  "create_thread",
  "handoff_thread",
  "send_message_to_thread",
])

function isCodexInjectedOutput(namespace: string, name: string): boolean {
  if (namespace === "agent") {
    return (
      CODEX_INJECTED_AGENT_OUTPUT_NAMES.has(name)
      || /^(?:codex_apps_selected_page_part_[1-9]\d*_of_[1-9]\d*|codex_apps_writing_block_edits(?:_part_[1-9]\d*_of_[1-9]\d*)?)$/u.test(
        name,
      )
    )
  }
  if (namespace === "codex_app") {
    return CODEX_INJECTED_APP_OUTPUT_NAMES.has(name)
  }
  return namespace === "cloud_threads" && name === "send_message"
}

function appendCodexPageContext(
  item: ResponseInputItem,
  messages: Array<AnthropicInputMessage>,
): "context" | "delegation" | null {
  const namespace = getStringField(item, "namespace")
  const name = getStringField(item, "name")
  if (
    !isRecord(item)
    || item.type !== "function_call_output"
    || (item.call_id !== undefined && item.call_id !== null)
    || !namespace
    || !name
    || !isCodexInjectedOutput(namespace, name)
  ) {
    return null
  }

  // Codex Desktop injects untrusted context snapshots and cross-thread
  // delegation payloads without a preceding tool call. Keep them as user
  // context rather than an orphan tool_result or a system instruction.
  const content = translateToolResultContent(item.output, `${item.type}.output`)
  appendUserBlock(messages, { type: "text", text: `${namespace}.${name}:` })
  if (typeof content === "string") {
    if (content) appendUserBlock(messages, { type: "text", text: content })
  } else {
    for (const block of content) appendUserBlock(messages, block)
  }
  return namespace === "agent" ? "context" : "delegation"
}

export function translateInputMessage(
  item: ResponseInputItem,
  messages: Array<AnthropicInputMessage>,
  system: Array<AnthropicTextBlock>,
  userMessageSeen: boolean,
): void {
  if (!isRecord(item)) {
    throw new ResponsesMessagesTranslationError(
      "Invalid Responses message item",
    )
  }
  const role = getStringField(item, "role")
  if (
    role !== "user"
    && role !== "assistant"
    && role !== "system"
    && role !== "developer"
  ) {
    throw new ResponsesMessagesTranslationError(
      "Responses message items require a supported role",
    )
  }

  if (role === "developer" && !userMessageSeen) return

  if (role === "system") {
    const text = translateSystemContent(item.content, "message.content")
    if (text) system.push({ type: "text", text })
    return
  }

  if (role === "assistant") {
    const blocks = translateAssistantContent(item.content, "message.content")
    for (const block of blocks) {
      appendAssistantBlock(messages, block)
    }
    return
  }

  const content = translateUserContent(item.content, "message.content")
  messages.push({ role: "user", content })
}

export function translateInputAgentMessage(
  item: ResponseInputAgentMessage,
  messages: Array<AnthropicInputMessage>,
): void {
  const content = translateUserContent(item.content, "agent_message.content")
  messages.push({ role: "user", content })
}

export function appendDeveloperPrompts(
  system: Array<AnthropicTextBlock>,
  input: ResponsesPayload["input"],
): void {
  if (!Array.isArray(input)) return

  const prompts: Array<string> = []
  for (const item of input) {
    if (prompts.length >= MAX_DEVELOPER_PROMPTS) break
    const type = getItemType(item)
    const role = getStringField(item, "role")
    if (
      type === "agent_message"
      || (type === "function_call_output"
        && isRecord(item)
        && (item.call_id === undefined || item.call_id === null)
        && getStringField(item, "namespace") !== "agent"
        && isCodexInjectedOutput(
          getStringField(item, "namespace") ?? "",
          getStringField(item, "name") ?? "",
        ))
    ) {
      break
    }
    if ((type === undefined || type === "message") && role === "user") break
    if ((type !== undefined && type !== "message") || role !== "developer") {
      continue
    }
    prompts.push(
      translateSystemContent(
        isRecord(item) ? item.content : undefined,
        "message.content",
      ),
    )
  }

  const [firstPrompt, ...remainingPrompts] = prompts
  if (firstPrompt) system.push({ type: "text", text: firstPrompt })

  const mergedPrompts = remainingPrompts.filter(Boolean).join("\n\n")
  if (mergedPrompts) system.push({ type: "text", text: mergedPrompts })
}

export function translateInputReasoning(
  item: ResponseInputReasoning,
  messages: Array<AnthropicInputMessage>,
): void {
  const thinking =
    Array.isArray(item.summary) ?
      item.summary
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n\n")
    : ""
  appendAssistantBlock(messages, {
    type: "thinking",
    thinking: thinking || "",
    signature: item.encrypted_content ?? "",
  })
}

export function translateInputToolCall(
  item: ResponseInputItem,
  kind: MessagesToolDescriptor["kind"],
  messages: Array<AnthropicInputMessage>,
  registry: MessagesToolRegistry,
): void {
  if (!isRecord(item)) {
    throw new ResponsesMessagesTranslationError(
      "Invalid Responses tool call item",
    )
  }
  const name = requireStringField(item, "name", `${kind}_tool_call`)
  const namespace = getOptionalStringField(item, "namespace") ?? undefined
  const toolIdentity = { kind, name, namespace }
  // Historical calls preserve conversation state; they do not define tools.
  const descriptor =
    findOriginalDescriptor(registry, kind, name, namespace)
    ?? createMessagesToolDescriptor(toolIdentity, registry)
  const input =
    kind === "custom" ?
      { input: getStringField(item, "input") ?? "" }
    : parseFunctionArguments(
        getStringField(item, "arguments") ?? "{}",
        `${kind}_tool_call.arguments`,
      )
  appendAssistantBlock(messages, {
    type: "tool_use",
    id: requireStringField(item, "call_id", `${kind}_tool_call`),
    name: descriptor.alias,
    input,
  })
}

export function translateUserContent(
  value: unknown,
  path: string,
): string | Array<AnthropicUserContentBlock> {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (!Array.isArray(value)) {
    throw new ResponsesMessagesTranslationError(
      `${path} must be text or an array`,
    )
  }
  return value.map((part, index) =>
    translateUserContentPart(part, `${path}[${index}]`),
  )
}

export function translateAssistantContent(
  value: unknown,
  path: string,
): Array<AnthropicAssistantContentBlock> {
  if (value === undefined || value === null) return []
  if (typeof value === "string") {
    return value ? [{ type: "text", text: value }] : []
  }
  if (!Array.isArray(value)) {
    throw new ResponsesMessagesTranslationError(
      `${path} must be text or an array`,
    )
  }
  return value.map((part, index) => {
    if (!isRecord(part)) {
      throw new ResponsesMessagesTranslationError(
        `${path}[${index}] must be an object`,
      )
    }
    const type = getStringField(part, "type")
    if (type !== "input_text" && type !== "output_text" && type !== "text") {
      throw new ResponsesMessagesTranslationError(
        `${path}[${index}] has unsupported assistant content type '${type ?? "unknown"}'`,
      )
    }
    return {
      type: "text" as const,
      text: requireStringField(part, "text", `${path}[${index}]`),
    }
  })
}

export function translateSystemContent(value: unknown, path: string): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (!Array.isArray(value)) {
    throw new ResponsesMessagesTranslationError(
      `${path} must be text or an array`,
    )
  }
  return value
    .map((part, index) => {
      if (!isRecord(part)) {
        throw new ResponsesMessagesTranslationError(
          `${path}[${index}] must be an object`,
        )
      }
      const type = getStringField(part, "type")
      if (type !== "input_text" && type !== "output_text" && type !== "text") {
        throw new ResponsesMessagesTranslationError(
          `${path}[${index}] has unsupported system content type '${type ?? "unknown"}'`,
        )
      }
      return requireStringField(part, "text", `${path}[${index}]`)
    })
    .join("\n\n")
}

export function translateUserContentPart(
  part: unknown,
  path: string,
): AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock {
  if (!isRecord(part)) {
    throw new ResponsesMessagesTranslationError(`${path} must be an object`)
  }
  const type = getStringField(part, "type")
  if (type === "input_text" || type === "output_text" || type === "text") {
    return { type: "text", text: requireStringField(part, "text", path) }
  }
  if (type === "encrypted_content") {
    return {
      type: "text",
      text: requireStringField(part, "encrypted_content", path),
    }
  }
  if (type === "input_image") {
    return translateImagePart(part, path)
  }
  if (type === "input_file") {
    return translateFilePart(part, path)
  }
  throw new ResponsesMessagesTranslationError(
    `${path} has unsupported content type '${type ?? "unknown"}'`,
  )
}

export function translateToolResultContent(
  value: unknown,
  path: string,
): string | Array<ReturnType<typeof translateUserContentPart>> {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (!Array.isArray(value)) {
    throw new ResponsesMessagesTranslationError(
      `${path} must be text or an array`,
    )
  }
  // Codex Desktop can emit empty input_text parts in tool outputs; Anthropic
  // rejects empty text blocks, so drop them instead of failing translation.
  const blocks = value.flatMap((part, index) =>
    isEmptyTextContentPart(part) ?
      []
    : [translateUserContentPart(part, `${path}[${index}]`)],
  )
  return blocks.length > 0 ? blocks : ""
}

export function isEmptyTextContentPart(part: unknown): boolean {
  if (!isRecord(part)) return false
  const type = part.type
  return (
    (type === "input_text" || type === "output_text" || type === "text")
    && part.text === ""
  )
}

export function translateImagePart(
  part: Record<string, unknown>,
  path: string,
): AnthropicImageBlock {
  const imageUrl = getStringField(part, "image_url")
  if (!imageUrl) {
    throw new ResponsesMessagesTranslationError(
      `${path} requires image_url; file_id-only images cannot be sent to Messages`,
    )
  }
  const parsed = parseDataUrl(imageUrl)
  if (
    !parsed
    || (parsed.mediaType !== "image/jpeg"
      && parsed.mediaType !== "image/png"
      && parsed.mediaType !== "image/gif"
      && parsed.mediaType !== "image/webp")
  ) {
    throw new ResponsesMessagesTranslationError(
      `${path} requires a base64 JPEG, PNG, GIF, or WebP data URL`,
    )
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: parsed.mediaType,
      data: parsed.data,
    },
  }
}

export function translateFilePart(
  part: Record<string, unknown>,
  path: string,
): AnthropicDocumentBlock {
  const fileData = getStringField(part, "file_data")
  if (!fileData) {
    throw new ResponsesMessagesTranslationError(
      `${path} requires file_data; file_id-only files cannot be sent to Messages`,
    )
  }
  const parsed = parseDataUrl(fileData)
  if (parsed?.mediaType !== "application/pdf") {
    throw new ResponsesMessagesTranslationError(
      `${path} requires a base64 PDF data URL`,
    )
  }
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: parsed.data,
    },
    title: getOptionalStringField(part, "filename") ?? "document.pdf",
  }
}

export function translateToolChoice(
  toolChoice: ResponsesPayload["tool_choice"],
  registry: MessagesToolRegistry,
): AnthropicMessagesPayload["tool_choice"] {
  if (!toolChoice || registry.tools.length === 0) return undefined
  if (typeof toolChoice === "string") {
    if (toolChoice === "required") return { type: "any" }
    return { type: toolChoice }
  }

  const kind = (toolChoice as { type: string }).type
  if (kind !== "function" && kind !== "custom") {
    throw new ResponsesMessagesTranslationError(
      `Responses Messages fallback does not support tool_choice type '${String(kind)}'`,
    )
  }
  const rawName = (toolChoice as { name: string }).name
  const namespace = getOptionalStringField(toolChoice, "namespace") ?? undefined
  const descriptor = findOriginalDescriptor(registry, kind, rawName, namespace)
  if (!descriptor) {
    throw new ResponsesMessagesTranslationError(
      `tool_choice references unknown ${kind} tool '${rawName}'`,
    )
  }
  return { type: "tool", name: descriptor.alias }
}

export const EPHEMERAL_CACHE_CONTROL: AnthropicCacheControl = {
  type: "ephemeral",
}

// Mark the stable prompt prefix for Anthropic prompt caching: the last system
// block plus the tail block of the final user message.
export function applyEphemeralCacheControl(
  messages: Array<AnthropicInputMessage>,
  system: Array<AnthropicTextBlock>,
): void {
  const lastSystemBlock = system.at(-1)
  if (lastSystemBlock) {
    lastSystemBlock.cache_control = { ...EPHEMERAL_CACHE_CONTROL }
  }

  const lastUserMessage = messages.findLast(
    (message): message is AnthropicUserMessage => message.role === "user",
  )
  if (!lastUserMessage) return

  if (typeof lastUserMessage.content === "string") {
    const textBlock: AnthropicTextBlock = {
      type: "text",
      text: lastUserMessage.content,
      cache_control: { ...EPHEMERAL_CACHE_CONTROL },
    }
    lastUserMessage.content = [textBlock]
    return
  }

  const lastBlock = lastUserMessage.content.at(-1)
  if (!lastBlock) return
  lastBlock.cache_control = { ...EPHEMERAL_CACHE_CONTROL }
}

export function appendAssistantBlock(
  messages: Array<AnthropicInputMessage>,
  block: AnthropicAssistantContentBlock,
): void {
  const last = messages.at(-1)
  if (last?.role === "assistant" && Array.isArray(last.content)) {
    last.content.push(block)
    return
  }
  const message: AnthropicAssistantMessage = {
    role: "assistant",
    content: [block],
  }
  messages.push(message)
}

export function appendUserBlock(
  messages: Array<AnthropicInputMessage>,
  block: AnthropicUserContentBlock,
): void {
  const last = messages.at(-1)
  if (last?.role === "user" && Array.isArray(last.content)) {
    last.content.push(block)
    return
  }
  const message: AnthropicUserMessage = { role: "user", content: [block] }
  messages.push(message)
}
