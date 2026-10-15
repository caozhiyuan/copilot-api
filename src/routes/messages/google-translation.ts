import { createHash, randomUUID } from "node:crypto"

import { HTTPError } from "~/lib/error"
import type {
  AnthropicAssistantContentBlock,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicThinkingBlock,
  AnthropicToolResultBlock,
  AnthropicUsage,
} from "~/lib/types/anthropic"
import type {
  GoogleGenerateContentPayload,
  GoogleGenerateContentResponse,
  GooglePart,
  GoogleUsageMetadata,
} from "~/lib/types/google"

import { translateGoogleThinking } from "./google-thinking"

// Anthropic has a standard opaque signature field only on thinking blocks.
// Signature-only blocks carry signatures belonging to the preceding text/tool
// part, keeping the bridge stateless across tool-result requests and restarts.
const GOOGLE_SIGNATURE_PREFIX = "google:"

export function encodeGoogleSignature(
  signature: string,
  target: "thinking" | "previous",
): string {
  return (
    GOOGLE_SIGNATURE_PREFIX
    + Buffer.from(JSON.stringify({ signature, target })).toString("base64url")
  )
}

function decodeGoogleSignature(
  value: string,
): { signature: string; target: "thinking" | "previous" } | undefined {
  if (!value.startsWith(GOOGLE_SIGNATURE_PREFIX)) return undefined
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(
        value.slice(GOOGLE_SIGNATURE_PREFIX.length),
        "base64url",
      ).toString(),
    )
    if (typeof decoded !== "object" || decoded === null) return undefined
    const { signature, target } = decoded as Record<string, unknown>
    if (
      typeof signature === "string"
      && (target === "thinking" || target === "previous")
    ) {
      return { signature, target }
    }
  } catch {
    // A foreign or malformed signature must never be sent to Google.
  }
  return undefined
}

function translateThinkingBlock(
  block: AnthropicThinkingBlock,
  parts: Array<GooglePart>,
): void {
  const decoded = decodeGoogleSignature(block.signature)
  if (!decoded) return
  if (decoded.target === "previous") {
    const previous = parts.at(-1)
    if (previous) previous.thoughtSignature = decoded.signature
    return
  }
  parts.push({
    text: block.thinking,
    thought: true,
    thoughtSignature: decoded.signature,
  })
}

function invalidRequest(message: string): never {
  throw new HTTPError(
    message,
    Response.json(
      { error: { type: "invalid_request_error", message } },
      { status: 400 },
    ),
  )
}

function translateToolResult(
  block: AnthropicToolResultBlock,
  toolNames: Map<string, string>,
): GooglePart {
  const name = toolNames.get(block.tool_use_id)
  if (!name)
    invalidRequest(
      `Google tool result has no matching tool_use: ${block.tool_use_id}`,
    )
  const text: Array<string> = []
  const media: Array<Pick<GooglePart, "inlineData">> = []
  const references: Array<{ $ref: string }> = []
  const mediaPrefix = createHash("sha256")
    .update(block.tool_use_id)
    .digest("hex")
    .slice(0, 16)
  if (typeof block.content === "string") {
    text.push(block.content)
  } else {
    for (const item of block.content) {
      if (item.type === "text") text.push(item.text)
      else if (item.type === "tool_reference") text.push(item.tool_name)
      else {
        const displayName = `tool-result-${mediaPrefix}-${media.length}`
        media.push({
          inlineData: {
            mimeType: item.source.media_type,
            data: item.source.data,
            displayName,
          },
        })
        references.push({ $ref: displayName })
      }
    }
  }
  return {
    functionResponse: {
      id: block.tool_use_id,
      name,
      response: {
        [block.is_error ? "error" : "output"]:
          media.length > 0 ?
            { text: text.join("\n"), media: references }
          : text.join("\n"),
      },
      ...(media.length > 0 && { parts: media }),
    },
  }
}

export function translateAnthropicToGoogle(
  payload: AnthropicMessagesPayload,
): GoogleGenerateContentPayload {
  const result: GoogleGenerateContentPayload = {
    contents: [],
    generationConfig: {
      candidateCount: 1,
      maxOutputTokens: payload.max_tokens,
      temperature: payload.temperature,
      topP: payload.top_p,
      topK: payload.top_k,
      stopSequences: payload.stop_sequences,
    },
  }
  const systemParts: Array<GooglePart> =
    typeof payload.system === "string" ?
      [{ text: payload.system }]
    : (payload.system ?? []).map((block) => ({ text: block.text }))
  const toolNames = new Map<string, string>()

  for (const message of payload.messages) {
    if (message.role === "system") {
      systemParts.push(
        ...(typeof message.content === "string" ?
          [{ text: message.content }]
        : message.content.map((block) => ({ text: block.text }))),
      )
      continue
    }
    const parts: Array<GooglePart> = []
    if (typeof message.content === "string") {
      if (message.content) parts.push({ text: message.content })
    } else {
      for (const block of message.content) {
        switch (block.type) {
          case "text":
            if (block.text) parts.push({ text: block.text })
            break
          case "image":
          case "document":
            parts.push({
              inlineData: {
                mimeType: block.source.media_type,
                data: block.source.data,
              },
            })
            break
          case "tool_use":
            toolNames.set(block.id, block.name)
            parts.push({
              functionCall: {
                id: block.id,
                name: block.name,
                args: block.input,
              },
            })
            break
          case "tool_result":
            parts.push(translateToolResult(block, toolNames))
            break
          case "thinking":
            translateThinkingBlock(block, parts)
            break
        }
      }
    }
    if (!parts.length) continue
    const role = message.role === "assistant" ? "model" : "user"
    const previous = result.contents.at(-1)
    if (previous?.role === role) previous.parts.push(...parts)
    else result.contents.push({ role, parts })
  }
  if (systemParts.length) result.systemInstruction = { parts: systemParts }

  if (payload.tools?.length) {
    result.tools = [
      {
        functionDeclarations: payload.tools.map((tool) => {
          if (tool.type && tool.type !== "custom")
            invalidRequest(
              `Google does not support Anthropic server tool '${tool.type}'`,
            )
          return {
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: tool.input_schema,
          }
        }),
      },
    ]
  }
  if (payload.tool_choice) {
    const choice = payload.tool_choice
    result.toolConfig = {
      functionCallingConfig: {
        mode:
          choice.type === "none" ? "NONE"
          : choice.type === "auto" ? "AUTO"
          : "ANY",
        ...(choice.type === "tool"
          && choice.name && { allowedFunctionNames: [choice.name] }),
      },
    }
  }
  if (payload.output_config?.format) {
    result.generationConfig.responseMimeType = "application/json"
    result.generationConfig.responseJsonSchema =
      payload.output_config.format.schema
  }
  const thinkingConfig = translateGoogleThinking(payload)
  if (thinkingConfig) result.generationConfig.thinkingConfig = thinkingConfig
  return result
}

export function translateGoogleUsage(
  usage: GoogleUsageMetadata = {},
): AnthropicUsage {
  const cached = usage.cachedContentTokenCount ?? 0
  return {
    input_tokens: Math.max(0, (usage.promptTokenCount ?? 0) - cached),
    output_tokens:
      (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    cache_read_input_tokens: cached,
  }
}

export function getGoogleStopReason(
  finishReason: string | undefined,
  hasTools: boolean,
  blocked?: string,
): AnthropicResponse["stop_reason"] {
  if (
    blocked
    || [
      "SAFETY",
      "RECITATION",
      "BLOCKLIST",
      "PROHIBITED_CONTENT",
      "SPII",
      "IMAGE_SAFETY",
    ].includes(finishReason ?? "")
  )
    return "refusal"
  if (finishReason === "MAX_TOKENS") return "max_tokens"
  if (finishReason === "STOP") return hasTools ? "tool_use" : "end_turn"
  throw new Error(
    `Google generation ended without a successful finish reason (${finishReason ?? "missing"})`,
  )
}

export function googleSignatureBlock(
  signature: string,
): AnthropicThinkingBlock {
  return {
    type: "thinking",
    thinking: "",
    signature: encodeGoogleSignature(signature, "previous"),
  }
}

export function translateGoogleToAnthropic(
  response: GoogleGenerateContentResponse,
  model: string,
): AnthropicResponse {
  if (response.error)
    throw new Error(response.error.message ?? "Google generation failed")
  const candidate = response.candidates?.[0]
  const content: Array<AnthropicAssistantContentBlock> = []
  for (const part of candidate?.content?.parts ?? []) {
    if (part.functionCall) {
      const call = part.functionCall
      content.push({
        type: "tool_use",
        id: call.id || `toolu_${randomUUID()}`,
        name: call.name,
        input: call.args ?? {},
      })
    } else if (part.thought) {
      content.push({
        type: "thinking",
        thinking: part.text ?? "",
        signature:
          part.thoughtSignature ?
            encodeGoogleSignature(part.thoughtSignature, "thinking")
          : "",
      })
      continue
    } else if (part.text !== undefined) {
      content.push({ type: "text", text: part.text })
    }
    if (part.thoughtSignature)
      content.push(googleSignatureBlock(part.thoughtSignature))
  }
  return {
    id: response.responseId || `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: getGoogleStopReason(
      candidate?.finishReason,
      content.some((block) => block.type === "tool_use"),
      response.promptFeedback?.blockReason,
    ),
    stop_sequence: null,
    usage: translateGoogleUsage(response.usageMetadata),
  }
}
