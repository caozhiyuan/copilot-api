import type {
  AnthropicAssistantContentBlock,
  AnthropicDocumentBlock,
  AnthropicImageBlock,
  AnthropicInputMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicToolResultContentBlock,
  AnthropicToolUseBlock,
  AnthropicUsage,
  AnthropicUserContentBlock,
} from "~/lib/types/anthropic"
import type {
  GoogleContent,
  GoogleGenerateContentRequest,
  GoogleGenerateContentResponse,
  GoogleGenerationConfig,
  GooglePart,
  GoogleTool,
  GoogleToolConfig,
  GoogleUsageMetadata,
} from "~/lib/types/google"
import { normalizeToolSchema } from "~/routes/messages/completions-translation"
import { decodeGoogleSignature } from "~/routes/messages/google-translation"
import { resolveDefaultMaxOutputTokens } from "~/routes/responses/messages-translation/to-messages"

const OPAQUE_SIGNATURE_PREFIX = "copilot-api:sig:"
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u

const GEMINI_SCHEMA_TYPE_MAP: Record<string, string> = {
  ARRAY: "array",
  BOOLEAN: "boolean",
  INTEGER: "integer",
  NULL: "null",
  NUMBER: "number",
  OBJECT: "object",
  STRING: "string",
}

const SUPPORTED_ANTHROPIC_IMAGE_TYPES = new Set<
  AnthropicImageBlock["source"]["media_type"]
>(["image/jpeg", "image/png", "image/gif", "image/webp"])

const GOOGLE_STATUS_BY_HTTP_CODE: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  502: "INTERNAL",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
}

export class GoogleMessagesTranslationError extends Error {
  readonly status: 400 | 502

  constructor(message: string, status: 400 | 502 = 400) {
    super(message)
    this.name = "GoogleMessagesTranslationError"
    this.status = status
  }
}

export function createGoogleErrorPayload(
  status: number,
  message: string,
): { error: { code: number; message: string; status: string } } {
  return {
    error: {
      code: status,
      message,
      status: GOOGLE_STATUS_BY_HTTP_CODE[status] ?? "INTERNAL",
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCanonicalBase64(value: string): boolean {
  if (
    value.length === 0
    || value.length % 4 !== 0
    || !BASE64_PATTERN.test(value)
  ) {
    return false
  }
  return Buffer.from(value, "base64").toString("base64") === value
}

export interface DecodedAnthropicSignature {
  signature: string
  target?: "thinking" | "previous" | { toolUseId: string }
}

/**
 * Converts an Anthropic thinking signature into a Gemini-valid base64
 * `thoughtSignature`. Canonical base64 tokens (such as Gemini `reasoning_opaque`
 * or Claude signatures) pass through unchanged; non-base64 tokens (such as
 * Responses `id@encrypted_content`) are bijectively base64-wrapped so Gemini
 * protobuf `bytes` parsers never reject them.
 */
export function encodeSignatureForGoogle(
  signature: string,
): DecodedAnthropicSignature {
  const googleDecoded = decodeGoogleSignature(signature)
  if (googleDecoded) {
    return {
      signature: googleDecoded.signature,
      target: googleDecoded.target,
    }
  }

  if (isCanonicalBase64(signature)) {
    const rawUtf8 = Buffer.from(signature, "base64").toString("utf8")
    if (!rawUtf8.startsWith(OPAQUE_SIGNATURE_PREFIX)) {
      return { signature }
    }
  }

  return {
    signature: Buffer.from(
      `${OPAQUE_SIGNATURE_PREFIX}${signature}`,
      "utf8",
    ).toString("base64"),
  }
}

/**
 * Restores an Anthropic thinking signature from a Gemini `thoughtSignature`.
 * Unwraps tokens previously wrapped by `encodeSignatureForGoogle` and leaves
 * native signatures untouched.
 */
export function decodeSignatureFromGoogle(thoughtSignature: string): string {
  if (!isCanonicalBase64(thoughtSignature)) {
    return thoughtSignature
  }
  const decoded = Buffer.from(thoughtSignature, "base64").toString("utf8")
  if (
    decoded.startsWith(OPAQUE_SIGNATURE_PREFIX)
    && Buffer.from(decoded, "utf8").toString("base64") === thoughtSignature
  ) {
    return decoded.slice(OPAQUE_SIGNATURE_PREFIX.length)
  }
  return thoughtSignature
}

export function normalizeGeminiSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const nullable = schema.nullable === true

  for (const [key, value] of Object.entries(schema)) {
    if (key === "nullable") continue

    if (key === "type" && typeof value === "string") {
      if (value === "TYPE_UNSPECIFIED") continue
      const mapped = GEMINI_SCHEMA_TYPE_MAP[value] ?? value.toLowerCase()
      result.type = nullable && mapped !== "null" ? [mapped, "null"] : mapped
      continue
    }

    if (
      (key === "properties" || key === "$defs" || key === "definitions")
      && isRecord(value)
    ) {
      const normalizedMap: Record<string, unknown> = {}
      for (const [propKey, propValue] of Object.entries(value)) {
        normalizedMap[propKey] =
          isRecord(propValue) ? normalizeGeminiSchema(propValue) : propValue
      }
      result[key] = normalizedMap
      continue
    }

    if (
      (key === "items" || key === "additionalProperties")
      && isRecord(value)
    ) {
      result[key] = normalizeGeminiSchema(value)
      continue
    }

    if (
      (key === "anyOf"
        || key === "oneOf"
        || key === "allOf"
        || key === "prefixItems")
      && Array.isArray(value)
    ) {
      result[key] = value.map((item: unknown) =>
        isRecord(item) ? normalizeGeminiSchema(item) : item,
      )
      continue
    }

    result[key] = value
  }

  return result
}

function extractTextParts(content: GoogleContent | undefined): Array<string> {
  if (!content || !Array.isArray(content.parts)) return []
  const texts: Array<string> = []
  for (const part of content.parts) {
    if (typeof part.text === "string" && part.text.length > 0) {
      texts.push(part.text)
    }
  }
  return texts
}

function translateInlineDataPart(
  inlineData: NonNullable<GooglePart["inlineData"]>,
): AnthropicImageBlock | AnthropicDocumentBlock | AnthropicTextBlock {
  const normalizedMime = inlineData.mimeType.trim().toLowerCase()
  const imageMime =
    normalizedMime === "image/jpg" ? "image/jpeg" : normalizedMime

  if (
    SUPPORTED_ANTHROPIC_IMAGE_TYPES.has(
      imageMime as AnthropicImageBlock["source"]["media_type"],
    )
  ) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: imageMime as AnthropicImageBlock["source"]["media_type"],
        data: inlineData.data,
      },
    }
  }

  if (normalizedMime === "application/pdf") {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: inlineData.data,
      },
      ...(inlineData.displayName ? { title: inlineData.displayName } : {}),
    }
  }

  if (
    normalizedMime.startsWith("text/")
    || normalizedMime === "application/json"
    || normalizedMime === "application/xml"
  ) {
    const decoded = Buffer.from(inlineData.data, "base64").toString("utf8")
    return { type: "text", text: decoded }
  }

  return {
    type: "text",
    text: `[Unsupported inline attachment (${inlineData.mimeType})]`,
  }
}

function serializeFunctionResponseBody(response: unknown): {
  text: string
  isError: boolean
} {
  if (!isRecord(response)) {
    return {
      text: response === undefined ? "" : JSON.stringify(response),
      isError: false,
    }
  }

  const keys = Object.keys(response)
  if (keys.length === 1) {
    if (typeof response.output === "string") {
      return { text: response.output, isError: false }
    }
    if (typeof response.result === "string") {
      return { text: response.result, isError: false }
    }
    if (typeof response.error === "string") {
      return { text: response.error, isError: true }
    }
  }

  return {
    text: JSON.stringify(response),
    isError: false,
  }
}

function translateFunctionResponse(
  functionResponse: NonNullable<GooglePart["functionResponse"]>,
  toolUseId: string,
): AnthropicToolResultBlock {
  const { text, isError } = serializeFunctionResponseBody(
    functionResponse.response,
  )
  const mediaParts = (functionResponse.parts ?? []).flatMap((part) =>
    part.inlineData ? [translateInlineDataPart(part.inlineData)] : [],
  )

  if (mediaParts.length === 0) {
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: text,
      ...(isError ? { is_error: true } : {}),
    }
  }

  const contentBlocks: Array<AnthropicToolResultContentBlock> = []
  if (text.length > 0) {
    contentBlocks.push({ type: "text", text })
  }
  contentBlocks.push(...mediaParts)
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: contentBlocks,
    ...(isError ? { is_error: true } : {}),
  }
}

function translateToolsAndChoice(
  rawTools: Array<GoogleTool> | undefined,
  toolConfig: GoogleToolConfig | undefined,
): {
  tools?: Array<AnthropicTool>
  toolChoice?: AnthropicMessagesPayload["tool_choice"]
} {
  let tools: Array<AnthropicTool> = []
  for (const toolGroup of rawTools ?? []) {
    if (!Array.isArray(toolGroup.functionDeclarations)) continue
    for (const declaration of toolGroup.functionDeclarations) {
      if (!declaration?.name) continue
      const rawSchema =
        isRecord(declaration.parametersJsonSchema) ?
          declaration.parametersJsonSchema
        : isRecord(declaration.parameters) ?
          normalizeGeminiSchema(declaration.parameters)
        : { type: "object", properties: {} }

      tools.push({
        name: declaration.name,
        ...(declaration.description !== undefined ?
          { description: declaration.description }
        : {}),
        input_schema: normalizeToolSchema(rawSchema),
      })
    }
  }

  if (tools.length === 0) {
    return {}
  }

  const callingConfig = toolConfig?.functionCallingConfig
  const allowedNames = callingConfig?.allowedFunctionNames?.filter(
    (name): name is string => typeof name === "string" && name.length > 0,
  )
  const mode = callingConfig?.mode

  if (mode === "NONE") {
    return { tools, toolChoice: { type: "none" } }
  }

  if (allowedNames && allowedNames.length > 0) {
    if (mode === "ANY" && allowedNames.length === 1) {
      return {
        tools,
        toolChoice: { type: "tool", name: allowedNames[0] },
      }
    }
    const allowedSet = new Set(allowedNames)
    const filtered = tools.filter((tool) => allowedSet.has(tool.name))
    if (filtered.length > 0) {
      tools = filtered
    }
  }

  if (mode === "ANY") {
    return { tools, toolChoice: { type: "any" } }
  }

  if (mode === "AUTO" || mode === "VALIDATED") {
    return { tools, toolChoice: { type: "auto" } }
  }

  return { tools }
}

function translateThinkingLevelToEffort(
  level: string | undefined,
): NonNullable<AnthropicMessagesPayload["output_config"]>["effort"] {
  if (!level) return undefined
  switch (level.trim().toUpperCase()) {
    case "MINIMAL":
    case "LOW":
      return "low"
    case "MEDIUM":
      return "medium"
    case "HIGH":
      return "high"
    case "XHIGH":
      return "xhigh"
    case "MAX":
      return "max"
    default:
      return undefined
  }
}

function translateGenerationConfig(
  config: GoogleGenerationConfig | undefined,
  model: string,
): Pick<
  AnthropicMessagesPayload,
  | "max_tokens"
  | "temperature"
  | "top_p"
  | "top_k"
  | "stop_sequences"
  | "thinking"
  | "output_config"
> {
  const defaultMaxTokens = resolveDefaultMaxOutputTokens(model)
  const requestedMaxTokens =
    (
      typeof config?.maxOutputTokens === "number"
      && Number.isFinite(config.maxOutputTokens)
      && config.maxOutputTokens >= 1
    ) ?
      Math.floor(config.maxOutputTokens)
    : undefined

  let maxTokens = requestedMaxTokens ?? defaultMaxTokens
  let thinking: AnthropicMessagesPayload["thinking"]
  let outputConfig: AnthropicMessagesPayload["output_config"]

  const thinkingConfig = config?.thinkingConfig
  if (thinkingConfig) {
    const budget = thinkingConfig.thinkingBudget
    if (typeof budget === "number" && Number.isFinite(budget)) {
      if (budget === 0) {
        thinking = { type: "disabled" }
      } else if (budget > 0) {
        const budgetTokens = Math.floor(budget)
        thinking = { type: "enabled", budget_tokens: budgetTokens }
        if (requestedMaxTokens === undefined && maxTokens <= budgetTokens) {
          maxTokens = budgetTokens + 4096
        }
      }
    }

    const effort = translateThinkingLevelToEffort(thinkingConfig.thinkingLevel)
    if (effort) {
      outputConfig = { ...outputConfig, effort }
    }
  }

  if (config?.responseMimeType === "application/json") {
    const rawSchema =
      isRecord(config.responseJsonSchema) ? config.responseJsonSchema
      : isRecord(config.responseSchema) ?
        normalizeGeminiSchema(config.responseSchema)
      : undefined
    if (rawSchema) {
      outputConfig = {
        ...outputConfig,
        format: {
          type: "json_schema",
          schema: rawSchema,
        },
      }
    }
  }

  return {
    max_tokens: Math.max(1, maxTokens),
    ...(typeof config?.temperature === "number" ?
      { temperature: config.temperature }
    : {}),
    ...(typeof config?.topP === "number" ? { top_p: config.topP } : {}),
    ...(typeof config?.topK === "number" ? { top_k: config.topK } : {}),
    ...((
      Array.isArray(config?.stopSequences) && config.stopSequences.length > 0
    ) ?
      { stop_sequences: config.stopSequences }
    : {}),
    ...(thinking ? { thinking } : {}),
    ...(outputConfig ? { output_config: outputConfig } : {}),
  }
}

function appendOrMergeUserBlocks(
  messages: Array<AnthropicInputMessage>,
  toolResults: Array<AnthropicToolResultBlock>,
  userBlocks: Array<AnthropicUserContentBlock>,
): void {
  const combined: Array<AnthropicUserContentBlock> = [
    ...toolResults,
    ...userBlocks,
  ]
  if (combined.length === 0) return

  const previous = messages.at(-1)
  if (previous?.role === "user") {
    const previousBlocks: Array<AnthropicUserContentBlock> =
      typeof previous.content === "string" ?
        previous.content.length > 0 ?
          [{ type: "text", text: previous.content }]
        : []
      : previous.content
    const existingToolResults = previousBlocks.filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === "tool_result",
    )
    const existingOther = previousBlocks.filter(
      (block) => block.type !== "tool_result",
    )
    previous.content = [
      ...existingToolResults,
      ...toolResults,
      ...existingOther,
      ...userBlocks,
    ]
    return
  }

  messages.push({ role: "user", content: combined })
}

function appendOrMergeAssistantBlocks(
  messages: Array<AnthropicInputMessage>,
  blocks: Array<AnthropicAssistantContentBlock>,
): void {
  if (blocks.length === 0) return

  const previous = messages.at(-1)
  if (previous?.role === "assistant") {
    const previousBlocks: Array<AnthropicAssistantContentBlock> =
      typeof previous.content === "string" ?
        previous.content.length > 0 ?
          [{ type: "text", text: previous.content }]
        : []
      : previous.content
    const merged = [...previousBlocks, ...blocks]
    const thinkingBlocks = merged.filter((block) => block.type === "thinking")
    const otherBlocks = merged.filter((block) => block.type !== "thinking")
    previous.content = [...thinkingBlocks, ...otherBlocks]
    return
  }

  messages.push({ role: "assistant", content: blocks })
}

export function translateGoogleToMessages(
  payload: GoogleGenerateContentRequest,
  options: { model: string; stream: boolean },
): AnthropicMessagesPayload {
  if (
    typeof payload !== "object"
    || payload === null
    || Array.isArray(payload)
  ) {
    throw new GoogleMessagesTranslationError(
      "Request body must be a JSON object",
      400,
    )
  }

  if (!Array.isArray(payload.contents) || payload.contents.length === 0) {
    throw new GoogleMessagesTranslationError(
      "Google generateContent request requires a non-empty 'contents' array",
      400,
    )
  }

  const systemBlocks: Array<AnthropicTextBlock> = []
  for (const text of extractTextParts(
    payload.systemInstruction ?? payload.system_instruction,
  )) {
    systemBlocks.push({ type: "text", text })
  }

  const messages: Array<AnthropicInputMessage> = []
  const pendingCallIdsByName = new Map<string, Array<string>>()
  let callCounter = 0

  const nextSyntheticCallId = (): string => `call_google_${++callCounter}`

  for (const content of payload.contents) {
    if (!content || !Array.isArray(content.parts)) continue

    if (content.role === "system") {
      for (const text of extractTextParts(content)) {
        systemBlocks.push({ type: "text", text })
      }
      continue
    }

    if (content.role === "model") {
      const thoughtTexts: Array<string> = []
      let thoughtSignature: string | undefined
      const assistantOtherBlocks: Array<AnthropicAssistantContentBlock> = []

      for (const part of content.parts) {
        if (
          typeof part.thoughtSignature === "string"
          && part.thoughtSignature.length > 0
        ) {
          thoughtSignature = decodeSignatureFromGoogle(part.thoughtSignature)
        }

        if (part.thought === true) {
          if (typeof part.text === "string" && part.text.length > 0) {
            thoughtTexts.push(part.text)
          }
          continue
        }

        if (part.functionCall) {
          const call = part.functionCall
          const id = call.id?.trim() || nextSyntheticCallId()
          const queue = pendingCallIdsByName.get(call.name) ?? []
          queue.push(id)
          pendingCallIdsByName.set(call.name, queue)

          const toolUseBlock: AnthropicToolUseBlock = {
            type: "tool_use",
            id,
            name: call.name,
            input: isRecord(call.args) ? call.args : {},
          }
          assistantOtherBlocks.push(toolUseBlock)
          continue
        }

        if (typeof part.text === "string" && part.text.length > 0) {
          assistantOtherBlocks.push({ type: "text", text: part.text })
        }
      }

      const assistantBlocks: Array<AnthropicAssistantContentBlock> = []
      const combinedThought = thoughtTexts.join("")
      if (combinedThought.length > 0 || thoughtSignature !== undefined) {
        const thinkingBlock: AnthropicThinkingBlock = {
          type: "thinking",
          thinking: combinedThought,
          signature: thoughtSignature ?? "",
        }
        assistantBlocks.push(thinkingBlock)
      }
      assistantBlocks.push(...assistantOtherBlocks)

      appendOrMergeAssistantBlocks(messages, assistantBlocks)
      continue
    }

    const toolResults: Array<AnthropicToolResultBlock> = []
    const userBlocks: Array<AnthropicUserContentBlock> = []

    for (const part of content.parts) {
      if (part.functionResponse) {
        const resp = part.functionResponse
        const queue = pendingCallIdsByName.get(resp.name)
        let toolUseId = resp.id?.trim()
        if (toolUseId) {
          if (queue) {
            const idx = queue.indexOf(toolUseId)
            if (idx >= 0) queue.splice(idx, 1)
          }
        } else {
          toolUseId = queue?.shift() ?? nextSyntheticCallId()
        }
        toolResults.push(translateFunctionResponse(resp, toolUseId))
        continue
      }

      if (part.inlineData) {
        userBlocks.push(translateInlineDataPart(part.inlineData))
        continue
      }

      if (part.fileData?.fileUri) {
        userBlocks.push({
          type: "text",
          text: `[File reference: ${part.fileData.fileUri}]`,
        })
        continue
      }

      if (typeof part.text === "string" && part.text.length > 0) {
        userBlocks.push({ type: "text", text: part.text })
      }
    }

    appendOrMergeUserBlocks(messages, toolResults, userBlocks)
  }

  if (messages.length === 0) {
    throw new GoogleMessagesTranslationError(
      "Google generateContent 'contents' must contain at least one translatable message",
      400,
    )
  }

  const { tools, toolChoice } = translateToolsAndChoice(
    payload.tools,
    payload.toolConfig,
  )
  const generation = translateGenerationConfig(
    payload.generationConfig,
    options.model,
  )

  return {
    model: options.model,
    messages,
    stream: options.stream,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...generation,
  }
}

export function mapAnthropicStopReasonToGoogle(
  stopReason: AnthropicResponse["stop_reason"],
): string {
  switch (stopReason) {
    case "max_tokens":
      return "MAX_TOKENS"
    case "refusal":
      return "SAFETY"
    case "end_turn":
    case "stop_sequence":
    case "tool_use":
    case "pause_turn":
    case null:
    default:
      return "STOP"
  }
}

export function translateAnthropicUsageToGoogle(
  usage: Partial<AnthropicUsage> | undefined,
): GoogleUsageMetadata | undefined {
  if (!usage) return undefined

  const inputTokens = usage.input_tokens ?? 0
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0
  const promptTokenCount = inputTokens + cacheReadTokens + cacheCreationTokens
  const candidatesTokenCount = usage.output_tokens ?? 0

  return {
    promptTokenCount,
    candidatesTokenCount,
    ...(usage.cache_read_input_tokens !== undefined ?
      { cachedContentTokenCount: cacheReadTokens }
    : {}),
    totalTokenCount: promptTokenCount + candidatesTokenCount,
  }
}

export function translateAnthropicResponseToGoogle(
  response: AnthropicResponse,
  fallbackModel: string,
): GoogleGenerateContentResponse {
  const parts: Array<GooglePart> = []
  let pendingSignature: string | undefined
  const toolSignaturesById = new Map<string, string>()

  for (const block of response.content) {
    if (block.type === "thinking") {
      const encoded =
        block.signature.length > 0 ?
          encodeSignatureForGoogle(block.signature)
        : undefined

      if (block.thinking.length > 0) {
        const thoughtPart: GooglePart = {
          text: block.thinking,
          thought: true,
        }
        if (encoded?.target === "thinking") {
          thoughtPart.thoughtSignature = encoded.signature
        }
        parts.push(thoughtPart)
      }

      if (encoded) {
        if (encoded.target && typeof encoded.target === "object") {
          toolSignaturesById.set(encoded.target.toolUseId, encoded.signature)
        } else if (encoded.target === "previous") {
          const previous = parts.at(-1)
          if (previous && !previous.thoughtSignature) {
            previous.thoughtSignature = encoded.signature
          } else {
            pendingSignature = encoded.signature
          }
        } else if (
          encoded.target !== "thinking"
          || block.thinking.length === 0
        ) {
          pendingSignature = encoded.signature
        }
      }
      continue
    }

    if (block.type === "text") {
      parts.push({ text: block.text })
      continue
    }

    if (block.type === "tool_use") {
      const targetedSignature = toolSignaturesById.get(block.id)
      parts.push({
        functionCall: {
          id: block.id,
          name: block.name,
          args: block.input,
        },
        ...(targetedSignature ? { thoughtSignature: targetedSignature } : {}),
      })
    }
  }

  if (pendingSignature) {
    const firstFunctionCall = parts.find(
      (part) => part.functionCall !== undefined,
    )
    if (firstFunctionCall) {
      if (!firstFunctionCall.thoughtSignature) {
        firstFunctionCall.thoughtSignature = pendingSignature
      }
    } else {
      const lastPart = parts.at(-1)
      if (lastPart && !lastPart.thoughtSignature) {
        lastPart.thoughtSignature = pendingSignature
      } else {
        parts.push({ text: "", thoughtSignature: pendingSignature })
      }
    }
  }

  const usageMetadata = translateAnthropicUsageToGoogle(response.usage)

  return {
    responseId: response.id,
    modelVersion: response.model || fallbackModel,
    candidates: [
      {
        index: 0,
        content: {
          role: "model",
          parts,
        },
        finishReason: mapAnthropicStopReasonToGoogle(response.stop_reason),
      },
    ],
    ...(usageMetadata ? { usageMetadata } : {}),
  }
}
