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
  AnthropicWebSearchToolResultBlock,
} from "~/lib/types/anthropic"
import type {
  GoogleContent,
  GoogleGenerateContentRequest,
  GoogleGenerateContentResponse,
  GoogleGenerationConfig,
  GoogleGroundingChunk,
  GoogleGroundingMetadata,
  GoogleInlineData,
  GooglePart,
  GoogleTool,
  GoogleToolConfig,
  GoogleUsageMetadata,
} from "~/lib/types/google"
import { normalizeToolSchema } from "~/routes/messages/completions-translation"
import { decodeGoogleSignature } from "~/routes/messages/google-translation"
import { resolveDefaultMaxOutputTokens } from "~/routes/responses/messages-translation/to-messages"

import {
  encodeAntigravityToolCallSignature,
  flushAntigravitySignatures,
  hasAntigravitySignature,
  isResponsesThinkingSignature,
  restoreAntigravityReasoningParts,
  type PositionedSignature,
} from "./antigravity-signatures"

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

// Gemini encodes these int64 schema constraints as decimal strings.
const GEMINI_SCHEMA_COUNT_FIELDS = new Set([
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minProperties",
  "maxProperties",
])
const UNSIGNED_INTEGER_PATTERN = /^\d+$/u

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
 * Responses `encrypted_content@id`) are bijectively base64-wrapped so Gemini
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
      GEMINI_SCHEMA_COUNT_FIELDS.has(key)
      && typeof value === "string"
      && UNSIGNED_INTEGER_PATTERN.test(value)
    ) {
      const count = Number(value)
      if (Number.isSafeInteger(count)) {
        result[key] = count
        continue
      }
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

function normalizeInlineData(raw: unknown): GoogleInlineData | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) {
    throw new GoogleMessagesTranslationError(
      "Google inlineData must be an object",
      400,
    )
  }

  const { mimeType, data, displayName } = raw
  if (typeof mimeType !== "string" || !mimeType || typeof data !== "string") {
    throw new GoogleMessagesTranslationError(
      "Google inlineData requires string 'mimeType' and 'data'",
      400,
    )
  }

  return {
    mimeType,
    data,
    ...(typeof displayName === "string" ? { displayName } : {}),
  }
}

function normalizeFileData(raw: unknown): GooglePart["fileData"] {
  if (!isRecord(raw)) return undefined
  const { fileUri, mimeType } = raw
  if (typeof fileUri !== "string" || !fileUri) return undefined
  return {
    fileUri,
    ...(typeof mimeType === "string" ? { mimeType } : {}),
  }
}

function normalizeGooglePart(part: GooglePart): GooglePart {
  if (typeof part !== "object" || part === null || Array.isArray(part)) {
    return {}
  }
  const {
    thoughtSignature,
    functionCall,
    functionResponse: rawFunctionResponse,
  } = part
  const inlineData = normalizeInlineData(part.inlineData)
  const fileData = normalizeFileData(part.fileData)
  const functionResponse =
    rawFunctionResponse ?
      {
        ...rawFunctionResponse,
        ...(Array.isArray(rawFunctionResponse.parts) ?
          {
            parts: rawFunctionResponse.parts.map((mediaPart) => {
              const inlineData = normalizeInlineData(mediaPart.inlineData)
              return inlineData ? { inlineData } : {}
            }),
          }
        : {}),
      }
    : undefined

  return {
    ...(part.text !== undefined ? { text: part.text } : {}),
    ...(part.thought !== undefined ? { thought: part.thought } : {}),
    ...(typeof thoughtSignature === "string" ? { thoughtSignature } : {}),
    ...(inlineData !== undefined ? { inlineData } : {}),
    ...(fileData !== undefined ? { fileData } : {}),
    ...(functionCall !== undefined ? { functionCall } : {}),
    ...(functionResponse !== undefined ? { functionResponse } : {}),
  }
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
  const mediaParts = (functionResponse.parts ?? []).flatMap(({ inlineData }) =>
    inlineData ? [translateInlineDataPart(inlineData)] : [],
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

function isGoogleSearchToolGroup(toolGroup: GoogleTool): boolean {
  return (
    isRecord(toolGroup.googleSearch)
    || isRecord(toolGroup.google_search)
    || isRecord(toolGroup.googleSearchRetrieval)
    || isRecord(toolGroup.google_search_retrieval)
  )
}

function createAnthropicWebSearchTool(): AnthropicTool {
  // Server tools carry `type` and intentionally omit `input_schema`.
  return {
    type: "web_search_20250305",
    name: "web_search",
  } as unknown as AnthropicTool
}

function translateToolsAndChoice(
  rawTools: Array<GoogleTool> | undefined,
  toolConfig: GoogleToolConfig | undefined,
): {
  tools?: Array<AnthropicTool>
  toolChoice?: AnthropicMessagesPayload["tool_choice"]
} {
  let tools: Array<AnthropicTool> = []
  let hasGoogleSearch = false
  for (const toolGroup of rawTools ?? []) {
    if (isGoogleSearchToolGroup(toolGroup)) {
      hasGoogleSearch = true
    }
    const declarations = toolGroup.functionDeclarations
    if (!Array.isArray(declarations)) continue
    for (const declaration of declarations) {
      if (!declaration?.name) continue
      const { parametersJsonSchema, parameters } = declaration
      const rawSchema =
        isRecord(parametersJsonSchema) ? parametersJsonSchema
        : isRecord(parameters) ? normalizeGeminiSchema(parameters)
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
    if (hasGoogleSearch) {
      return { tools: [createAnthropicWebSearchTool()] }
    }
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

function isJsonMimeType(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase()
  return normalized === "application/json" || normalized === "application_json"
}

function isPlainTextMimeType(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase()
  return (
    normalized === ""
    || normalized === "text/plain"
    || normalized === "text_plain"
    || normalized === "mime_type_unspecified"
  )
}

function resolveResponseFormatSchema(
  responseFormat: GoogleGenerationConfig["responseFormat"],
): Record<string, unknown> | undefined {
  if (responseFormat === undefined) return undefined
  const entries =
    Array.isArray(responseFormat) ? responseFormat : [responseFormat]
  let resolvedSchema: Record<string, unknown> | undefined

  for (const entry of entries) {
    if (!isRecord(entry)) continue
    for (const [key, value] of Object.entries(entry)) {
      if (key !== "text" && value !== undefined) {
        throw new GoogleMessagesTranslationError(
          `Unsupported generationConfig.responseFormat field '${key}' for translated Google endpoint`,
          400,
        )
      }
    }

    const textFormat = entry.text
    if (textFormat === undefined) continue
    if (!isRecord(textFormat)) {
      throw new GoogleMessagesTranslationError(
        "generationConfig.responseFormat.text must be an object",
        400,
      )
    }

    const rawMimeType =
      typeof textFormat.mimeType === "string" ? textFormat.mimeType : undefined
    const rawSchema =
      isRecord(textFormat.jsonSchema) ? textFormat.jsonSchema
      : isRecord(textFormat.schema) ? normalizeGeminiSchema(textFormat.schema)
      : undefined

    if (rawSchema) {
      if (rawMimeType !== undefined && !isJsonMimeType(rawMimeType)) {
        throw new GoogleMessagesTranslationError(
          "generationConfig.responseFormat.text.schema requires a JSON mimeType",
          400,
        )
      }
      resolvedSchema = rawSchema
      continue
    }

    if (rawMimeType !== undefined && !isPlainTextMimeType(rawMimeType)) {
      throw new GoogleMessagesTranslationError(
        `Unsupported generationConfig.responseFormat.text.mimeType '${rawMimeType}' without a JSON schema`,
        400,
      )
    }
  }

  return resolvedSchema
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
  const rawMaxOutputTokens = config?.maxOutputTokens
  const requestedMaxTokens =
    (
      typeof rawMaxOutputTokens === "number"
      && Number.isFinite(rawMaxOutputTokens)
      && rawMaxOutputTokens >= 1
    ) ?
      Math.floor(rawMaxOutputTokens)
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

  const responseFormatSchema = resolveResponseFormatSchema(
    config?.responseFormat,
  )

  const legacyMimeType = config?.responseMimeType ?? undefined
  const rawLegacyJsonSchema = config?.responseJsonSchema
  const rawLegacySchema = config?.responseSchema
  const legacyStructuredSchema =
    isRecord(rawLegacyJsonSchema) ? rawLegacyJsonSchema
    : isRecord(rawLegacySchema) ? normalizeGeminiSchema(rawLegacySchema)
    : undefined

  if (legacyStructuredSchema) {
    if (legacyMimeType !== undefined && !isJsonMimeType(legacyMimeType)) {
      throw new GoogleMessagesTranslationError(
        "Structured output schema requires a JSON responseMimeType",
        400,
      )
    }
  } else if (
    legacyMimeType !== undefined
    && !isPlainTextMimeType(legacyMimeType)
  ) {
    throw new GoogleMessagesTranslationError(
      `Unsupported generationConfig.responseMimeType '${legacyMimeType}' without a JSON schema`,
      400,
    )
  }

  const outputSchema = responseFormatSchema ?? legacyStructuredSchema
  if (outputSchema) {
    outputConfig = {
      ...outputConfig,
      format: {
        type: "json_schema",
        schema: outputSchema,
      },
    }
  }

  const { topP, topK, stopSequences } = config ?? {}

  return {
    max_tokens: Math.max(1, maxTokens),
    ...(typeof config?.temperature === "number" ?
      { temperature: config.temperature }
    : {}),
    ...(typeof topP === "number" ? { top_p: topP } : {}),
    ...(typeof topK === "number" ? { top_k: topK } : {}),
    ...(Array.isArray(stopSequences) && stopSequences.length > 0 ?
      { stop_sequences: stopSequences }
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

function translateModelParts(
  parts: Array<GooglePart>,
  pendingCallIdsByName: Map<string, Array<string>>,
  nextSyntheticCallId: () => string,
): Array<AnthropicAssistantContentBlock> {
  const assistantBlocks: Array<AnthropicAssistantContentBlock> = []
  let segmentStartIndex = 0
  let openThinkingBlock: AnthropicThinkingBlock | undefined

  const attachSignatureToSegment = (
    decodedSignature: string,
    insertAtIndex: number,
  ): void => {
    if (openThinkingBlock) {
      openThinkingBlock.signature = decodedSignature
      openThinkingBlock = undefined
      return
    }
    assistantBlocks.splice(insertAtIndex, 0, {
      type: "thinking",
      thinking: "",
      signature: decodedSignature,
    })
  }

  for (const part of restoreAntigravityReasoningParts(parts)) {
    if ("type" in part) {
      assistantBlocks.push(part)
      openThinkingBlock = undefined
      segmentStartIndex = assistantBlocks.length
      continue
    }
    const decodedSignature =
      (
        typeof part.thoughtSignature === "string"
        && part.thoughtSignature.length > 0
      ) ?
        decodeSignatureFromGoogle(part.thoughtSignature)
      : undefined

    if (part.thought === true) {
      const thoughtText = typeof part.text === "string" ? part.text : ""
      const canAppendToOpen =
        openThinkingBlock !== undefined
        && assistantBlocks.at(-1) === openThinkingBlock

      if (!canAppendToOpen) {
        openThinkingBlock = undefined
        segmentStartIndex = assistantBlocks.length
      }

      if (decodedSignature !== undefined) {
        if (openThinkingBlock) {
          if (thoughtText.length > 0) {
            openThinkingBlock.thinking += thoughtText
          }
          openThinkingBlock.signature = decodedSignature
          openThinkingBlock = undefined
        } else {
          assistantBlocks.push({
            type: "thinking",
            thinking: thoughtText,
            signature: decodedSignature,
          })
        }
        segmentStartIndex = assistantBlocks.length
      } else if (thoughtText.length > 0) {
        if (openThinkingBlock) {
          openThinkingBlock.thinking += thoughtText
        } else {
          openThinkingBlock = {
            type: "thinking",
            thinking: thoughtText,
            signature: "",
          }
          assistantBlocks.push(openThinkingBlock)
        }
      }
      continue
    }

    if (part.functionCall) {
      if (decodedSignature !== undefined) {
        attachSignatureToSegment(decodedSignature, segmentStartIndex)
      }

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
      assistantBlocks.push(toolUseBlock)
      segmentStartIndex = assistantBlocks.length
      continue
    }

    if (typeof part.text === "string" && part.text.length > 0) {
      assistantBlocks.push({ type: "text", text: part.text })
    }

    if (decodedSignature !== undefined) {
      attachSignatureToSegment(decodedSignature, segmentStartIndex)
      segmentStartIndex = assistantBlocks.length
    }
  }

  return assistantBlocks
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
  for (const text of extractTextParts(payload.systemInstruction)) {
    systemBlocks.push({ type: "text", text })
  }

  const messages: Array<AnthropicInputMessage> = []
  const pendingCallIdsByName = new Map<string, Array<string>>()
  let pendingModelContents: Array<Array<GooglePart>> = []
  let callCounter = 0

  const nextSyntheticCallId = (): string => `call_google_${++callCounter}`

  const flushPendingModelParts = (): void => {
    if (pendingModelContents.length === 0) return
    const agyContentCount = pendingModelContents.filter((parts) =>
      hasAntigravitySignature(parts),
    ).length
    const assistantBlocks =
      agyContentCount > 1 ?
        pendingModelContents.flatMap((parts) =>
          translateModelParts(parts, pendingCallIdsByName, nextSyntheticCallId),
        )
      : translateModelParts(
          pendingModelContents.flat(),
          pendingCallIdsByName,
          nextSyntheticCallId,
        )
    pendingModelContents = []
    if (assistantBlocks.length > 0) {
      messages.push({ role: "assistant", content: assistantBlocks })
    }
  }

  for (const content of payload.contents) {
    if (!content || !Array.isArray(content.parts)) continue

    if (content.role === "system") {
      for (const text of extractTextParts(content)) {
        systemBlocks.push({ type: "text", text })
      }
      continue
    }

    const normalizedParts = content.parts.map(normalizeGooglePart)

    if (content.role === "model") {
      pendingModelContents.push(normalizedParts)
      continue
    }

    flushPendingModelParts()

    const toolResults: Array<AnthropicToolResultBlock> = []
    const userBlocks: Array<AnthropicUserContentBlock> = []

    for (const part of normalizedParts) {
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

  flushPendingModelParts()

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

export interface GroundingAccumulator {
  webSearchQueries: Array<string>
  seenQueries: Set<string>
  groundingChunks: Array<GoogleGroundingChunk>
  seenUrls: Set<string>
}

export function createGroundingAccumulator(): GroundingAccumulator {
  return {
    webSearchQueries: [],
    seenQueries: new Set(),
    groundingChunks: [],
    seenUrls: new Set(),
  }
}

export function recordWebSearchQuery(
  acc: GroundingAccumulator,
  input: unknown,
): void {
  if (!isRecord(input) || typeof input.query !== "string") return
  const query = input.query.trim()
  if (!query || acc.seenQueries.has(query)) return
  acc.seenQueries.add(query)
  acc.webSearchQueries.push(query)
}

export function recordWebSearchResults(
  acc: GroundingAccumulator,
  content: AnthropicWebSearchToolResultBlock["content"],
): void {
  if (!Array.isArray(content)) return
  for (const item of content) {
    if (item.type !== "web_search_result") continue
    const uri = typeof item.url === "string" ? item.url.trim() : ""
    if (!uri || acc.seenUrls.has(uri)) continue
    acc.seenUrls.add(uri)
    const title = typeof item.title === "string" ? item.title.trim() : ""
    acc.groundingChunks.push({
      web: {
        uri,
        ...(title ? { title } : {}),
      },
    })
  }
}

export function finalizeGroundingMetadata(
  acc: GroundingAccumulator,
): GoogleGroundingMetadata | undefined {
  if (acc.webSearchQueries.length === 0 && acc.groundingChunks.length === 0) {
    return undefined
  }
  return {
    ...(acc.webSearchQueries.length > 0 ?
      { webSearchQueries: acc.webSearchQueries }
    : {}),
    ...(acc.groundingChunks.length > 0 ?
      { groundingChunks: acc.groundingChunks }
    : {}),
  }
}

export function translateAnthropicResponseToGoogle(
  response: AnthropicResponse,
  fallbackModel: string,
  options: { preserveAntigravityReasoning?: boolean } = {},
): GoogleGenerateContentResponse {
  const parts: Array<GooglePart> = []
  const pendingSignatures: Array<string> = []
  const antigravitySignatures: Array<PositionedSignature> = []
  const toolSignaturesById = new Map<string, string>()
  const grounding = createGroundingAccumulator()
  let textLength = 0
  let thoughtText = ""

  const flushPendingSignatures = (attachToLastPart: boolean): void => {
    while (pendingSignatures.length > 0) {
      const signature = pendingSignatures.shift()
      if (!signature) continue
      if (attachToLastPart && pendingSignatures.length === 0) {
        const lastPart = parts.at(-1)
        if (lastPart && !lastPart.thoughtSignature && !lastPart.thought) {
          lastPart.thoughtSignature = signature
          continue
        }
      }
      parts.push({ text: "", thoughtSignature: signature })
    }
  }

  for (const block of response.content) {
    if (block.type === "thinking") {
      const useAntigravitySignature =
        Boolean(options.preserveAntigravityReasoning)
        && block.signature.length > 0
        && isResponsesThinkingSignature(block.signature)
      const encoded =
        !useAntigravitySignature && block.signature.length > 0 ?
          encodeSignatureForGoogle(block.signature)
        : undefined

      const startsNewThinkingSegment =
        encoded?.target !== "previous"
        && !(encoded?.target && typeof encoded.target === "object")
        && (block.thinking.length > 0 || block.signature.length > 0)
      if (startsNewThinkingSegment && pendingSignatures.length > 0) {
        flushPendingSignatures(true)
      }

      if (block.thinking.length > 0) {
        const thoughtPart: GooglePart = {
          text: block.thinking,
          thought: true,
        }
        if (encoded?.target === "thinking") {
          thoughtPart.thoughtSignature = encoded.signature
        }
        parts.push(thoughtPart)
        if (options.preserveAntigravityReasoning) thoughtText += block.thinking
      }

      if (useAntigravitySignature) {
        antigravitySignatures.push([
          block.signature,
          textLength,
          thoughtText.length,
        ])
      } else if (encoded) {
        if (encoded.target && typeof encoded.target === "object") {
          toolSignaturesById.set(encoded.target.toolUseId, encoded.signature)
        } else if (encoded.target === "previous") {
          const previous = parts.at(-1)
          if (previous && !previous.thoughtSignature) {
            previous.thoughtSignature = encoded.signature
          } else {
            pendingSignatures.push(encoded.signature)
          }
        } else if (
          encoded.target !== "thinking"
          || block.thinking.length === 0
        ) {
          pendingSignatures.push(encoded.signature)
        }
      }
      continue
    }

    if (block.type === "text") {
      parts.push({ text: block.text })
      textLength += block.text.length
      continue
    }

    if (block.type === "server_tool_use") {
      if (block.name === "web_search") {
        recordWebSearchQuery(grounding, block.input)
      }
      continue
    }

    if (block.type === "web_search_tool_result") {
      recordWebSearchResults(grounding, block.content)
      continue
    }

    if (block.type === "tool_use") {
      flushAntigravitySignatures(
        antigravitySignatures,
        pendingSignatures,
        thoughtText,
      )
      let thoughtSignature = toolSignaturesById.get(block.id)
      if (thoughtSignature) {
        toolSignaturesById.delete(block.id)
        flushPendingSignatures(false)
      } else if (pendingSignatures.length > 0) {
        while (pendingSignatures.length > 1) {
          const earlier = pendingSignatures.shift()
          if (earlier) {
            parts.push({ text: "", thoughtSignature: earlier })
          }
        }
        thoughtSignature = pendingSignatures.shift()
      }
      if (options.preserveAntigravityReasoning && block.id) {
        thoughtSignature = encodeAntigravityToolCallSignature(
          block.id,
          thoughtSignature,
        )
      }
      parts.push({
        functionCall: {
          id: block.id,
          name: block.name,
          args: block.input,
        },
        ...(thoughtSignature ? { thoughtSignature } : {}),
      })
      textLength = 0
      thoughtText = ""
    }
  }

  flushAntigravitySignatures(antigravitySignatures, pendingSignatures)
  flushPendingSignatures(true)

  const usageMetadata = translateAnthropicUsageToGoogle(response.usage)
  const groundingMetadata = finalizeGroundingMetadata(grounding)

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
        ...(groundingMetadata ? { groundingMetadata } : {}),
      },
    ],
    ...(usageMetadata ? { usageMetadata } : {}),
  }
}
