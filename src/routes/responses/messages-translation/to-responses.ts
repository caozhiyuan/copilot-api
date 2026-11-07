import { requestContext } from "~/lib/request-context"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicToolUseBlock,
} from "~/lib/types/anthropic"
import type {
  ResponseOutputCustomToolCall,
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  Reasoning,
  ResponsesPayload,
  ResponsesResult,
  ResponseUsage,
} from "~/lib/types/responses"

import {
  MESSAGES_COMPACTION_PREFIX,
  markMessagesReasoningId,
  ResponsesMessagesTranslationError,
  type MessagesResponseTranslationContext,
  type MessagesToolDescriptor,
  type MessagesToolRegistry,
} from "./constants"
import { isRecord } from "./parse"
import { createStableHash } from "./tools"

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

export function translateAssistantOutput(
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

export function translateToolUseOutput(
  block: AnthropicToolUseBlock,
  registry: MessagesToolRegistry,
  idSeed: string,
): ResponseOutputFunctionCall | ResponseOutputCustomToolCall {
  const descriptor = resolveToolDescriptor(registry, block.name)
  const common = {
    call_id: block.id,
    name: descriptor.name,
    status: "completed" as const,
    ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}),
  }
  if (descriptor.kind === "custom") {
    return {
      ...common,
      id: `ctc_${createStableHash(idSeed)}`,
      type: "custom_tool_call",
      input: decodeCustomToolInput(block.input),
    }
  }
  return {
    ...common,
    id: `fc_${createStableHash(idSeed)}`,
    type: "function_call",
    arguments: JSON.stringify(block.input),
  }
}

export function translateCompactionOutput(
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

export function extractAnthropicResponseText(
  response: AnthropicResponse,
): string {
  return response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
}

export function translateStopReason(
  stopReason: AnthropicResponse["stop_reason"],
): {
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

export function translateReasoningEffort(
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

export function resolveMetadataUserId(
  payload: ResponsesPayload,
): string | undefined {
  const sessionAffinity = requestContext.getStore()?.sessionAffinity?.trim()
  if (sessionAffinity) return sessionAffinity
  const metadataUserId = payload.metadata?.user_id
  if (metadataUserId?.trim()) return metadataUserId
  if (payload.safety_identifier?.trim()) return payload.safety_identifier
  if (payload.prompt_cache_key?.trim()) return payload.prompt_cache_key
  return undefined
}
