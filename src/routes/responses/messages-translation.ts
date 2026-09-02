import { createHash } from "node:crypto"

import { compactTextOnlyGuard } from "~/lib/compact"
import { requestContext } from "~/lib/request-context"
import type {
  AnthropicAssistantContentBlock,
  AnthropicAssistantMessage,
  AnthropicCacheControl,
  AnthropicDocumentBlock,
  AnthropicImageBlock,
  AnthropicInputMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolResultContentBlock,
  AnthropicToolUseBlock,
  AnthropicUserContentBlock,
  AnthropicUserMessage,
} from "~/lib/types/anthropic"
import type {
  NamespaceTool,
  ResponseInputAgentMessage,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseInputReasoning,
  ResponseOutputCustomToolCall,
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  Reasoning,
  ResponsesPayload,
  ResponsesResult,
  ResponseUsage,
} from "~/lib/types/responses"

export const MESSAGES_COMPACTION_PREFIX = "copilot-api:messages-compaction:v1:"
const MESSAGES_REASONING_ID_SUFFIX = "__a1"

export const markMessagesReasoningId = (id: string): string =>
  `${id}${MESSAGES_REASONING_ID_SUFFIX}`

export const isMessagesReasoningId = (id: unknown): boolean =>
  typeof id === "string" && id.endsWith(MESSAGES_REASONING_ID_SUFFIX)

export const MESSAGES_COMPACTION_PROMPT = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
  "Do NOT continue the task, make changes, or call any tools. Your only output must be the handoff summary.",
  "",
  "Include:",
  "- Current progress and key decisions made",
  "- Important context, constraints, or user preferences",
  "- What remains to be done (clear next steps)",
  "- Any critical data, examples, or references needed to continue",
  "",
  "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.",
  "",
  compactTextOnlyGuard,
].join("\n")

export const MESSAGES_TOOL_CALL_TIPS = [
  "# Tool Call Tips",
  "- Do NOT call `exec_command` directly; that tool does not exist. Use `functions__exec` to run commands instead.",
  '- The functions__exec tool accepts parameters only as {"input":"..."}; put the complete executable code inside input, including properly constructed tools.exec_command(...) calls and text(...) output handling.',
  "- Construct all tools.exec_command(...) arguments strictly according to its tool definition, and use OS/shell-compatible commands for Windows, Linux, and macOS.",
  "- Always assign the awaited tools.exec_command(...) call to a variable, then forward its output with text(result.output) and inspect result.exit_code; unforwarded output is silently dropped and makes results look empty.",
  "- Read files with the OS-native command (Get-Content/Test-Path on Windows PowerShell, cat/ls on POSIX), quote paths containing spaces, and verify the forwarded output is non-empty before concluding a file was read.",
].join("\n")

const COMPACTION_REPLAY_PROMPT =
  "The previous conversation was compacted. Continue from this handoff summary:\n\n"
const MAX_DEVELOPER_PROMPTS = 5
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u
const CUSTOM_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { input: { type: "string" } },
  required: ["input"],
  additionalProperties: false,
}

export class ResponsesMessagesTranslationError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = "ResponsesMessagesTranslationError"
    this.status = status
  }
}

export interface MessagesToolDescriptor {
  alias: string
  kind: "custom" | "function"
  name: string
  namespace?: string
}

export interface MessagesToolRegistry {
  byAlias: Map<string, MessagesToolDescriptor>
  byOriginal: Map<string, MessagesToolDescriptor>
  tools: Array<AnthropicTool>
}

export interface ResponsesToMessagesTranslation {
  compaction: boolean
  messagesPayload: AnthropicMessagesPayload
  originalPayload: ResponsesPayload
  publicModel: string
  registry: MessagesToolRegistry
}

export type MessagesResponseTranslationContext = Omit<
  ResponsesToMessagesTranslation,
  "messagesPayload"
>

interface ToolRegistration {
  description?: string | null
  kind: MessagesToolDescriptor["kind"]
  name: string
  namespace?: string
  parameters?: Record<string, unknown> | null
}

interface ResponsesInputNormalization {
  compaction: boolean
  input: string | Array<ResponseInputItem> | undefined
}

export function translateResponsesToMessages(
  payload: ResponsesPayload,
  options: { model: string; publicModel?: string; toolCallTips?: boolean },
): ResponsesToMessagesTranslation {
  const registry = createToolRegistry(payload)
  const normalized = normalizeResponsesInput(payload.input)
  const { messages, system } = translateInputToAnthropic(
    normalized.input,
    registry,
    payload.instructions,
    payload.input,
    options.toolCallTips ?? false,
  )

  if (normalized.compaction) {
    messages.push({ role: "user", content: MESSAGES_COMPACTION_PROMPT })
  }

  if (messages.length === 0) {
    throw new ResponsesMessagesTranslationError(
      "Responses input must contain at least one translatable message",
    )
  }

  applyEphemeralCacheControl(messages, system)

  const reasoningEffort = translateReasoningEffort(payload.reasoning?.effort)
  const metadataUserId = resolveMetadataUserId(payload)
  const messagesPayload: AnthropicMessagesPayload = {
    model: options.model,
    messages,
    max_tokens: Math.max(1, payload.max_output_tokens ?? 32_000),
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

  return {
    compaction: normalized.compaction,
    messagesPayload,
    originalPayload: payload,
    publicModel: options.publicModel ?? payload.model,
    registry,
  }
}

export function translateAnthropicToResponses(
  response: AnthropicResponse,
  context: MessagesResponseTranslationContext,
): ResponsesResult {
  const finish = translateStopReason(response.stop_reason)
  const output =
    context.compaction ?
      translateCompactionOutput(response)
    : translateAssistantOutput(response, context.registry)
  const outputText =
    context.compaction ? "" : extractAnthropicResponseText(response)

  return createMessagesBackedResponsesResult({
    context,
    id: toResponseId(response.id),
    output,
    outputText,
    status: finish.status,
    incompleteReason: finish.incompleteReason,
    usage: translateAnthropicUsage(response.usage),
    copilotUsage: response.copilot_usage,
  })
}

export function createMessagesBackedResponsesResult(options: {
  context: MessagesResponseTranslationContext
  createdAt?: number
  error?: ResponsesResult["error"]
  id: string
  incompleteReason?: "content_filter" | "max_output_tokens"
  output: Array<ResponseOutputItem>
  outputText: string
  status: string
  usage?: ResponseUsage | null
  copilotUsage?: ResponsesResult["copilot_usage"]
}): ResponsesResult {
  const { context } = options
  return {
    id: options.id,
    object: "response",
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    model: context.publicModel,
    output: options.output,
    output_text: options.outputText,
    status: options.status,
    copilot_usage: options.copilotUsage ?? null,
    usage: options.usage ?? null,
    error: options.error ?? null,
    incomplete_details:
      options.incompleteReason ? { reason: options.incompleteReason } : null,
    instructions: context.originalPayload.instructions ?? null,
    metadata: context.originalPayload.metadata ?? null,
    parallel_tool_calls: Boolean(context.originalPayload.parallel_tool_calls),
    temperature: context.originalPayload.temperature ?? null,
    tool_choice: context.originalPayload.tool_choice ?? "auto",
    tools: context.originalPayload.tools ?? [],
    top_p: context.originalPayload.top_p ?? null,
  }
}

export function translateAnthropicUsage(
  usage: AnthropicResponse["usage"] | undefined,
): ResponseUsage | null {
  if (!usage) return null

  const cachedTokens = usage.cache_read_input_tokens ?? 0
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
  const inputTokens = usage.input_tokens + cachedTokens + cacheWriteTokens
  const outputTokens = usage.output_tokens
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    input_tokens_details: {
      cached_tokens: cachedTokens,
      ...(cacheWriteTokens > 0 ? { cache_write_tokens: cacheWriteTokens } : {}),
    },
    output_tokens_details: { reasoning_tokens: 0 },
  }
}

export function encodeMessagesCompaction(summary: string): string {
  const payload = `${MESSAGES_COMPACTION_PREFIX}${Buffer.from(summary, "utf8").toString("base64url")}`
  return Buffer.from(payload, "utf8").toString("base64")
}

export function decodeMessagesCompaction(value: string): string | null {
  let payload = value
  if (!payload.startsWith(MESSAGES_COMPACTION_PREFIX)) {
    const decoded = Buffer.from(value, "base64")
    if (decoded.toString("base64") !== value) return null
    payload = decoded.toString("utf8")
  }
  if (!payload.startsWith(MESSAGES_COMPACTION_PREFIX)) return null

  try {
    const encoded = payload.slice(MESSAGES_COMPACTION_PREFIX.length)
    if (!encoded) return null
    return Buffer.from(encoded, "base64url").toString("utf8")
  } catch {
    return null
  }
}

export function resolveToolDescriptor(
  registry: MessagesToolRegistry,
  alias: string,
): MessagesToolDescriptor {
  return (
    registry.byAlias.get(alias) ?? {
      alias,
      kind: "function",
      name: alias,
    }
  )
}

export function decodeCustomToolInput(input: unknown): string {
  if (isRecord(input) && typeof input.input === "string") {
    return input.input
  }
  return typeof input === "string" ? input : JSON.stringify(input ?? {})
}

export function toResponseId(messageId: string): string {
  const normalized = messageId.replace(/^msg[-_]?/u, "")
  return `resp_${normalized || createStableHash(messageId)}`
}

function normalizeResponsesInput(
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

function createToolRegistry(payload: ResponsesPayload): MessagesToolRegistry {
  const registry: MessagesToolRegistry = {
    byAlias: new Map(),
    byOriginal: new Map(),
    tools: [],
  }

  for (const tool of payload.tools ?? []) {
    registerTool(tool, registry)
  }

  if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      const type = getItemType(item)
      if (type !== "additional_tools") continue
      for (const tool of getArrayField(item, "tools")) {
        registerTool(tool, registry)
      }
    }
  }

  return registry
}

function registerTool(
  tool: unknown,
  registry: MessagesToolRegistry,
  namespaces: Array<string> = [],
): void {
  if (!isRecord(tool)) {
    throw new ResponsesMessagesTranslationError(
      "Invalid Responses tool definition",
    )
  }

  const type = getStringField(tool, "type")
  if (type === "namespace") {
    const namespaceTool = tool as unknown as NamespaceTool
    const namespace = getStringField(namespaceTool, "name")
    if (!namespace || !Array.isArray(namespaceTool.tools)) {
      throw new ResponsesMessagesTranslationError(
        "Responses namespace tools require a name and tools array",
      )
    }
    for (const child of namespaceTool.tools) {
      registerTool(child, registry, [...namespaces, namespace])
    }
    return
  }

  if (type !== "function" && type !== "custom") {
    const suffix = type ? ` '${type}'` : " without a type"
    throw new ResponsesMessagesTranslationError(
      `Responses Messages fallback does not support tool${suffix}`,
    )
  }

  const name = getStringField(tool, "name")
  if (!name) {
    throw new ResponsesMessagesTranslationError(
      `Responses ${type} tools require a non-empty name`,
    )
  }

  registerMessagesTool(
    {
      kind: type,
      name,
      namespace: namespaces.length > 0 ? namespaces.join(".") : undefined,
      description: getOptionalStringField(tool, "description"),
      parameters:
        type === "function" && isRecord(tool.parameters) ?
          tool.parameters
        : null,
    },
    registry,
  )
}

function registerMessagesTool(
  registration: ToolRegistration,
  registry: MessagesToolRegistry,
): MessagesToolDescriptor {
  const originalKey = createOriginalToolKey(registration)
  const existing = registry.byOriginal.get(originalKey)
  if (existing) return existing

  const descriptor = createMessagesToolDescriptor(registration, registry)
  registry.byAlias.set(descriptor.alias, descriptor)
  registry.byOriginal.set(originalKey, descriptor)
  registry.tools.push({
    name: descriptor.alias,
    ...(registration.description ?
      { description: registration.description }
    : {}),
    input_schema:
      registration.kind === "custom" ?
        CUSTOM_TOOL_INPUT_SCHEMA
      : (registration.parameters ?? { type: "object", properties: {} }),
    ...(registration.kind === "custom" ? { strict: true } : {}),
  })
  return descriptor
}

function createMessagesToolDescriptor(
  registration: Pick<ToolRegistration, "kind" | "name" | "namespace">,
  registry: MessagesToolRegistry,
): MessagesToolDescriptor {
  const originalKey = createOriginalToolKey(registration)
  const preferredName =
    registration.namespace ?
      `${registration.namespace.replaceAll(".", "_")}__${registration.name}`
    : registration.name
  const alias = createToolAlias(preferredName, originalKey, registry)
  return {
    alias,
    kind: registration.kind,
    name: registration.name,
    ...(registration.namespace ? { namespace: registration.namespace } : {}),
  }
}

function translateInputToAnthropic(
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

function appendToolCallTips(system: Array<AnthropicTextBlock>): void {
  const lastSystemBlock = system.at(-1)
  if (!lastSystemBlock) {
    system.push({ type: "text", text: MESSAGES_TOOL_CALL_TIPS })
    return
  }
  lastSystemBlock.text = `${lastSystemBlock.text}\n\n${MESSAGES_TOOL_CALL_TIPS}`
}

function translateInputItems(
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
      case "additional_tools": {
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

function translateInputMessage(
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

function translateInputAgentMessage(
  item: ResponseInputAgentMessage,
  messages: Array<AnthropicInputMessage>,
): void {
  const content = translateUserContent(item.content, "agent_message.content")
  messages.push({ role: "user", content })
}

function appendDeveloperPrompts(
  system: Array<AnthropicTextBlock>,
  input: ResponsesPayload["input"],
): void {
  if (!Array.isArray(input)) return

  const prompts: Array<string> = []
  for (const item of input) {
    if (prompts.length >= MAX_DEVELOPER_PROMPTS) break
    const type = getItemType(item)
    const role = getStringField(item, "role")
    if (type === "agent_message") break
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

function translateInputReasoning(
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
    thinking: thinking || "Thinking...",
    signature: item.encrypted_content ?? "",
  })
}

function translateInputToolCall(
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
    registry.byOriginal.get(createOriginalToolKey(toolIdentity))
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

function translateUserContent(
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

function translateAssistantContent(
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

function translateSystemContent(value: unknown, path: string): string {
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

function translateUserContentPart(
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

function translateToolResultContent(
  value: unknown,
  path: string,
): string | Array<AnthropicToolResultContentBlock> {
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

function isEmptyTextContentPart(part: unknown): boolean {
  if (!isRecord(part)) return false
  const type = part.type
  return (
    (type === "input_text" || type === "output_text" || type === "text")
    && part.text === ""
  )
}

function translateImagePart(
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

function translateFilePart(
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

function translateToolChoice(
  toolChoice: ResponsesPayload["tool_choice"],
  registry: MessagesToolRegistry,
): AnthropicMessagesPayload["tool_choice"] {
  if (!toolChoice) return undefined
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

function translateAssistantOutput(
  response: AnthropicResponse,
  registry: MessagesToolRegistry,
): Array<ResponseOutputItem> {
  const output: Array<ResponseOutputItem> = []
  for (const [index, block] of response.content.entries()) {
    if (block.type === "thinking") {
      output.push({
        id: markMessagesReasoningId(
          `rs_${createStableHash(`${response.id}:${index}:reasoning`)}`,
        ),
        type: "reasoning",
        status: "completed",
        ...(block.thinking && block.thinking !== "Thinking..." ?
          { summary: [{ type: "summary_text", text: block.thinking }] }
        : {}),
        ...(block.signature ? { encrypted_content: block.signature } : {}),
      })
      continue
    }
    if (block.type === "text") {
      output.push({
        id: `msg_${createStableHash(`${response.id}:${index}:message`)}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: block.text,
            annotations: [],
          },
        ],
      })
      continue
    }
    if (block.type === "tool_use") {
      output.push(
        translateToolUseOutput(block, registry, `${response.id}:${index}:tool`),
      )
    }
  }
  return output
}

function translateToolUseOutput(
  block: AnthropicToolUseBlock,
  registry: MessagesToolRegistry,
  idSeed: string,
): ResponseOutputFunctionCall | ResponseOutputCustomToolCall {
  const descriptor = resolveToolDescriptor(registry, block.name)
  const common = {
    id: `fc_${createStableHash(idSeed)}`,
    call_id: block.id,
    name: descriptor.name,
    status: "completed" as const,
    ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}),
  }
  if (descriptor.kind === "custom") {
    return {
      ...common,
      type: "custom_tool_call",
      input: decodeCustomToolInput(block.input),
    }
  }
  return {
    ...common,
    type: "function_call",
    arguments: JSON.stringify(block.input),
  }
}

function translateCompactionOutput(
  response: AnthropicResponse,
): Array<ResponseOutputItem> {
  const hasToolUse = response.content.some((block) => block.type === "tool_use")
  if (hasToolUse) {
    throw new ResponsesMessagesTranslationError(
      "Messages API attempted a tool call during compaction",
      502,
    )
  }
  const summary = extractAnthropicResponseText(response).trim()
  if (!summary) {
    throw new ResponsesMessagesTranslationError(
      "Messages API compaction response did not contain a text summary",
      502,
    )
  }
  return [
    {
      id: `cmp_${createStableHash(summary)}`,
      type: "compaction",
      encrypted_content: encodeMessagesCompaction(summary),
    },
  ]
}

function extractAnthropicResponseText(response: AnthropicResponse): string {
  return response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
}

function translateStopReason(stopReason: AnthropicResponse["stop_reason"]): {
  status: "completed" | "incomplete"
  incompleteReason?: "content_filter" | "max_output_tokens"
} {
  if (stopReason === "max_tokens") {
    return { status: "incomplete", incompleteReason: "max_output_tokens" }
  }
  if (stopReason === "refusal") {
    return { status: "incomplete", incompleteReason: "content_filter" }
  }
  return { status: "completed" }
}

function translateReasoningEffort(
  effort: Reasoning["effort"],
):
  | NonNullable<AnthropicMessagesPayload["output_config"]>["effort"]
  | undefined {
  if (effort === "minimal") return "low"
  if (
    effort === "low"
    || effort === "medium"
    || effort === "high"
    || effort === "xhigh"
    || effort === "max"
  ) {
    return effort
  }
  return undefined
}

function resolveMetadataUserId(payload: ResponsesPayload): string | undefined {
  const sessionAffinity = requestContext.getStore()?.sessionAffinity?.trim()
  if (sessionAffinity) return sessionAffinity
  const metadataUserId = payload.metadata?.user_id
  if (metadataUserId?.trim()) return metadataUserId
  if (payload.safety_identifier?.trim()) return payload.safety_identifier
  if (payload.prompt_cache_key?.trim()) return payload.prompt_cache_key
  return undefined
}

const EPHEMERAL_CACHE_CONTROL: AnthropicCacheControl = { type: "ephemeral" }

// Mark the stable prompt prefix for Anthropic prompt caching: the last system
// block plus the tail block of the final user message.
function applyEphemeralCacheControl(
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

function appendAssistantBlock(
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

function appendUserBlock(
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

function parseFunctionArguments(
  value: string,
  _path: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (isRecord(parsed)) return parsed
  } catch {
    return {}
  }
  return {}
}

function parseDataUrl(
  value: string,
): { data: string; mediaType: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(value)
  if (!match) return null
  return { mediaType: match[1].toLowerCase(), data: match[2] }
}

function findOriginalDescriptor(
  registry: MessagesToolRegistry,
  kind: MessagesToolDescriptor["kind"],
  name: string,
  namespace?: string,
): MessagesToolDescriptor | undefined {
  const matches: Array<MessagesToolDescriptor> = []
  for (const descriptor of registry.byOriginal.values()) {
    if (descriptor.kind !== kind || descriptor.name !== name) continue
    if (namespace !== undefined) {
      if (descriptor.namespace === namespace) return descriptor
      continue
    }
    matches.push(descriptor)
  }
  return (
    matches.find((descriptor) => descriptor.namespace === undefined)
    ?? (matches.length === 1 ? matches[0] : undefined)
  )
}

function createOriginalToolKey(
  tool: Pick<MessagesToolDescriptor, "kind" | "name" | "namespace">,
): string {
  return [tool.kind, tool.namespace ?? "", tool.name].join("\u0000")
}

function createToolAlias(
  preferredName: string,
  originalKey: string,
  registry: MessagesToolRegistry,
): string {
  if (
    TOOL_NAME_PATTERN.test(preferredName)
    && !registry.byAlias.has(preferredName)
  ) {
    return preferredName
  }

  const sanitized = preferredName.replace(/[^A-Za-z0-9_-]+/gu, "_")
  const hash = createStableHash(originalKey).slice(0, 12)
  const prefix = `tool_${hash}_`
  const alias = `${prefix}${sanitized}`.slice(0, 64)
  if (!registry.byAlias.has(alias)) return alias
  return `tool_${createStableHash(`${originalKey}:collision`)}`.slice(0, 64)
}

function createStableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24)
}

function getItemType(value: unknown): string | undefined {
  return isRecord(value) && typeof value.type === "string" ?
      value.type
    : undefined
}

function getStringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined
  const fieldValue = value[field]
  return typeof fieldValue === "string" ? fieldValue : undefined
}

function getOptionalStringField(
  value: unknown,
  field: string,
): string | null | undefined {
  if (!isRecord(value)) return undefined
  const fieldValue = value[field]
  return typeof fieldValue === "string" || fieldValue === null ?
      fieldValue
    : undefined
}

function requireStringField(
  value: unknown,
  field: string,
  path: string,
): string {
  const result = getStringField(value, field)
  if (!result) {
    throw new ResponsesMessagesTranslationError(`${path}.${field} is required`)
  }
  return result
}

function getArrayField(value: unknown, field: string): Array<unknown> {
  if (!isRecord(value)) return []
  return Array.isArray(value[field]) ? value[field] : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
