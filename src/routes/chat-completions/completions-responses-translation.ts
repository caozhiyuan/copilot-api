/**
 * Translate OpenAI Chat Completions payloads to Responses API payloads
 * and translate Responses API results back to Chat Completions format.
 *
 * This is the completions-side counterpart of the Anthropic-to-Responses
 * translator in routes/messages/responses-translation.ts.
 */

import { getReasoningEffortForModel } from "~/lib/config"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"
import type {
  FunctionTool,
  Reasoning,
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseFunctionCallOutputItem,
  ResponseFunctionToolCallItem,
  ResponseOutputFunctionCall,
  ResponseOutputMessage,
  ResponsesPayload,
  ResponsesResult,
  ResponseUsage,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from "~/services/copilot/create-responses"

// ---------------------------------------------------------------------------
// Payload: Completions -> Responses
// ---------------------------------------------------------------------------

export const translateCompletionsToResponsesPayload = (
  payload: ChatCompletionsPayload,
): ResponsesPayload => {
  const { instructions, input } = translateMessages(payload.messages)
  const reasoningEffort = resolveReasoningEffort(payload)

  const responsesPayload: ResponsesPayload = {
    model: payload.model,
    input,
    instructions,
    stream: payload.stream,
    max_output_tokens: payload.max_completion_tokens ?? payload.max_tokens,
    // temperature intentionally omitted - reasoning models reject it
    top_p: payload.top_p,
    user: payload.user,
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
    parallel_tool_calls: payload.parallel_tool_calls ?? true,
    reasoning:
      reasoningEffort ? ({ effort: reasoningEffort } as Reasoning) : undefined,
    store: false,
    text: translateResponseFormat(payload.response_format),
  }

  return responsesPayload
}

// ---------------------------------------------------------------------------
// Result: Responses -> Completions
// ---------------------------------------------------------------------------

export const translateResponsesResultToCompletions = (
  response: ResponsesResult,
): ChatCompletionResponse => {
  const messageItems = response.output.filter(
    (item): item is ResponseOutputMessage => item.type === "message",
  )
  const functionCalls = response.output.filter(
    (item): item is ResponseOutputFunctionCall => item.type === "function_call",
  )

  const content = messageItems
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text" && "text" in part)
    .map((part) => (part as { text: string }).text)
    .join("")

  return {
    id: response.id,
    object: "chat.completion",
    created: response.created_at,
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(functionCalls.length > 0 && {
            tool_calls: functionCalls.map((fc) => ({
              id: fc.call_id,
              type: "function" as const,
              function: {
                name: fc.name,
                arguments: fc.arguments,
              },
            })),
          }),
        },
        logprobs: null,
        finish_reason: getFinishReason(response, functionCalls.length > 0),
      },
    ],
    usage: translateUsage(response.usage),
    ...(response.copilot_usage ?
      { copilot_usage: response.copilot_usage }
    : {}),
  }
}

// ---------------------------------------------------------------------------
// Messages translation
// ---------------------------------------------------------------------------

const translateMessages = (
  messages: Array<Message>,
): { instructions: string | null; input: Array<ResponseInputItem> } => {
  let instructions: string | null = null
  const input: Array<ResponseInputItem> = []

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      // Accumulate system/developer messages into instructions
      const text = extractTextContent(message.content)
      if (text) {
        instructions = instructions ? `${instructions}\n\n${text}` : text
      }
      continue
    }

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id ?? "",
        output: stringifyContent(message.content),
      } satisfies ResponseFunctionCallOutputItem)
      continue
    }

    // user or assistant
    if (hasContent(message.content)) {
      input.push({
        role: message.role,
        content: translateContent(message.content),
      } satisfies ResponseInputMessage)
    }

    if (message.role === "assistant" && message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
          status: "completed",
        } satisfies ResponseFunctionToolCallItem)
      }
    }
  }

  return { instructions, input }
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

const hasContent = (content: Message["content"]): boolean => {
  if (content === null || content === undefined) {
    return false
  }
  if (typeof content === "string") {
    return content.length > 0
  }
  return content.length > 0
}

const extractTextContent = (content: Message["content"]): string | null => {
  if (typeof content === "string") {
    return content
  }
  if (!content || content.length === 0) {
    return null
  }
  const text = content
    .filter(
      (part): part is Extract<ContentPart, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n\n")
  return text || null
}

const translateContent = (
  content: Message["content"],
): ResponseInputMessage["content"] => {
  if (typeof content === "string") {
    return content
  }
  if (!content || content.length === 0) {
    return ""
  }
  return content.map((part) => translateContentPart(part))
}

const translateContentPart = (part: ContentPart): ResponseInputContent => {
  if (part.type === "text") {
    return { type: "input_text", text: part.text }
  }
  if (part.type === "image_url") {
    return {
      type: "input_image",
      image_url: part.image_url.url,
      detail: part.image_url.detail ?? "auto",
    }
  }
  // file parts - pass through as input_file
  if (part.type === "file") {
    return {
      type: "input_file",
      file_data: part.file.file_data ?? null,
      filename: part.file.filename ?? null,
    }
  }
  // Fallback for unknown content types
  return { type: "input_text", text: "" }
}

const stringifyContent = (content: Message["content"]): string => {
  if (typeof content === "string") {
    return content
  }
  if (!content) {
    return ""
  }
  const text = content
    .filter(
      (part): part is Extract<ContentPart, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n\n")
  return text || JSON.stringify(content)
}

// ---------------------------------------------------------------------------
// Tools translation
// ---------------------------------------------------------------------------

const translateTools = (
  tools: Array<Tool> | null | undefined,
): Array<FunctionTool> | undefined => {
  if (!tools || tools.length === 0) {
    return undefined
  }
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.function.name,
    description: tool.function.description ?? null,
    parameters: tool.function.parameters,
    strict: null,
  }))
}

const translateToolChoice = (
  toolChoice: ChatCompletionsPayload["tool_choice"],
): ToolChoiceOptions | ToolChoiceFunction | undefined => {
  if (!toolChoice) {
    return undefined
  }
  if (typeof toolChoice === "string") {
    return toolChoice
  }
  return {
    type: "function",
    name: toolChoice.function.name,
  }
}

// ---------------------------------------------------------------------------
// response_format -> text.format
// ---------------------------------------------------------------------------

interface JsonSchemaResponseFormat {
  type: "json_schema"
  json_schema: {
    name: string
    schema: Record<string, unknown>
    strict?: boolean
  }
}

interface JsonObjectResponseFormat {
  type: "json_object"
}

type ResponseFormat = JsonSchemaResponseFormat | JsonObjectResponseFormat

/**
 * Recursively inject `additionalProperties: false` into every object-type
 * node of a JSON Schema. The Responses API requires this at every level
 * when `strict: true` is set, but callers (e.g. the OpenAI Python SDK,
 * Pydantic v2 model_json_schema()) often omit it.
 *
 * Handles:
 * - Direct object nodes (type: "object" with properties)
 * - Nested properties and array items
 * - $defs blocks (Pydantic v2 puts all nested models here)
 * - anyOf/oneOf/allOf variants (Pydantic uses anyOf for Optional fields)
 * - required array enforcement (strict mode demands all property keys listed)
 */
const ensureAdditionalPropertiesFalse = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const clone: Record<string, unknown> = { ...schema }

  if (clone.type === "object") {
    clone.additionalProperties = false

    if (clone.properties && typeof clone.properties === "object") {
      const propKeys = Object.keys(clone.properties as Record<string, unknown>)
      // Strict mode requires every property key in required
      clone.required = propKeys

      const props: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(
        clone.properties as Record<string, unknown>,
      )) {
        props[key] =
          value && typeof value === "object" && !Array.isArray(value) ?
            ensureAdditionalPropertiesFalse(value as Record<string, unknown>)
          : value
      }
      clone.properties = props
    }
  }

  if (
    clone.items
    && typeof clone.items === "object"
    && !Array.isArray(clone.items)
  ) {
    clone.items = ensureAdditionalPropertiesFalse(
      clone.items as Record<string, unknown>,
    )
  }

  // Recurse into $defs (Pydantic v2 schemas reference nested models via $defs)
  if (clone.$defs && typeof clone.$defs === "object") {
    const defs: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(
      clone.$defs as Record<string, unknown>,
    )) {
      defs[key] =
        value && typeof value === "object" && !Array.isArray(value) ?
          ensureAdditionalPropertiesFalse(value as Record<string, unknown>)
        : value
    }
    clone.$defs = defs
  }

  // Recurse into anyOf/oneOf/allOf (Pydantic uses anyOf for Optional/Union fields)
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(clone[keyword])) {
      clone[keyword] = (clone[keyword] as unknown[]).map((variant) =>
        variant && typeof variant === "object" && !Array.isArray(variant) ?
          ensureAdditionalPropertiesFalse(variant as Record<string, unknown>)
        : variant,
      )
    }
  }

  return clone
}

interface TextFormat {
  format:
    | { type: "json_object" }
    | {
        type: "json_schema"
        name: string
        schema: Record<string, unknown>
        strict?: boolean
      }
}

const translateResponseFormat = (
  responseFormat: ResponseFormat | null | undefined,
): TextFormat | undefined => {
  if (!responseFormat) {
    return undefined
  }

  if (responseFormat.type === "json_object") {
    return { format: { type: "json_object" } }
  }

  if (responseFormat.type === "json_schema") {
    return {
      format: {
        type: "json_schema",
        name: responseFormat.json_schema.name,
        schema: ensureAdditionalPropertiesFalse(
          responseFormat.json_schema.schema,
        ),
        strict: responseFormat.json_schema.strict ?? true,
      },
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Reasoning effort
// ---------------------------------------------------------------------------

const resolveReasoningEffort = (
  payload: ChatCompletionsPayload,
): Reasoning["effort"] => {
  // Explicit reasoning_effort from the request takes priority
  if (payload.reasoning_effort) {
    const effort = payload.reasoning_effort as Reasoning["effort"]
    if (effort) {
      return effort
    }
  }
  // Fall back to per-model config
  return getReasoningEffortForModel(payload.model)
}

// ---------------------------------------------------------------------------
// Usage translation
// ---------------------------------------------------------------------------

const translateUsage = (
  usage: ResponseUsage | null | undefined,
): ChatCompletionResponse["usage"] | undefined => {
  if (!usage) {
    return undefined
  }
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens,
    ...(usage.input_tokens_details?.cached_tokens !== undefined && {
      prompt_tokens_details: {
        cached_tokens: usage.input_tokens_details.cached_tokens,
      },
    }),
  }
}

// ---------------------------------------------------------------------------
// Finish reason
// ---------------------------------------------------------------------------

const getFinishReason = (
  response: ResponsesResult,
  hasFunctionCalls: boolean,
): "stop" | "length" | "tool_calls" | "content_filter" => {
  if (hasFunctionCalls) {
    return "tool_calls"
  }
  if (response.incomplete_details?.reason === "max_output_tokens") {
    return "length"
  }
  if (response.incomplete_details?.reason === "content_filter") {
    return "content_filter"
  }
  return "stop"
}
