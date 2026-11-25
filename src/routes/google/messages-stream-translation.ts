import type {
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicUsage,
} from "~/lib/types/anthropic"
import type {
  GoogleGenerateContentResponse,
  GoogleGroundingMetadata,
  GooglePart,
} from "~/lib/types/google"

import {
  encodeAntigravityToolCallSignature,
  flushAntigravitySignatures,
  isResponsesThinkingSignature,
  type PositionedSignature,
} from "./antigravity-signatures"
import {
  createGoogleErrorPayload,
  createGroundingAccumulator,
  encodeSignatureForGoogle,
  finalizeGroundingMetadata,
  GoogleMessagesTranslationError,
  mapAnthropicStopReasonToGoogle,
  recordWebSearchQuery,
  recordWebSearchResults,
  translateAnthropicUsageToGoogle,
} from "./messages-translation"

export interface MessagesStreamChunk {
  data?: string
  event?: string
}

type StreamBlockState =
  | { type: "thinking"; signature: string }
  | { type: "text" }
  | {
      type: "tool_use"
      id: string
      name: string
      inputJson: string
      initialInput: Record<string, unknown>
    }
  | {
      type: "server_tool_use"
      name: string
      inputJson: string
      initialInput: Record<string, unknown>
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseAnthropicEvent(data: string): AnthropicStreamEventData {
  try {
    const parsed: unknown = JSON.parse(data)
    if (
      !isRecord(parsed)
      || typeof parsed.type !== "string"
      || parsed.type.length === 0
    ) {
      throw new Error("missing event type")
    }
    return parsed as unknown as AnthropicStreamEventData
  } catch (error) {
    throw new GoogleMessagesTranslationError(
      `Invalid Messages API stream event: ${
        error instanceof Error ? error.message : String(error)
      }`,
      502,
    )
  }
}

function parseToolUseArguments(
  inputJson: string,
  initialInput: Record<string, unknown>,
): Record<string, unknown> {
  const trimmed = inputJson.trim()
  if (trimmed.length === 0) {
    return initialInput
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isRecord(parsed) ? parsed : { value: parsed }
  } catch (error) {
    throw new GoogleMessagesTranslationError(
      `Invalid tool call arguments JSON in Messages stream: ${
        error instanceof Error ? error.message : String(error)
      }`,
      502,
    )
  }
}

export async function* translateMessagesStreamToGoogle(
  chunks: AsyncIterable<MessagesStreamChunk>,
  options: {
    fallbackModel: string
    signal?: AbortSignal
    preserveAntigravityReasoning?: boolean
  },
): AsyncGenerator<GoogleGenerateContentResponse> {
  let responseId: string | undefined
  let modelVersion = options.fallbackModel
  let initialized = false
  let messageStopped = false
  let stopReason: AnthropicResponse["stop_reason"] = null
  const usage: Partial<AnthropicUsage> = {}
  let hasUsage = false

  const blocks = new Map<number, StreamBlockState>()
  const pendingSignatures: Array<string> = []
  const antigravitySignatures: Array<PositionedSignature> = []
  const toolSignaturesById = new Map<string, string>()
  const grounding = createGroundingAccumulator()
  let pendingInvalidToolArgsError: GoogleMessagesTranslationError | undefined
  let textLength = 0
  let thoughtText = ""

  const takePendingSignatureParts = (): Array<GooglePart> => {
    if (pendingSignatures.length === 0) return []
    const parts = pendingSignatures.map((thoughtSignature) => ({
      text: "",
      thoughtSignature,
    }))
    pendingSignatures.length = 0
    return parts
  }

  const buildChunk = (
    parts: Array<GooglePart>,
    finishReason?: string,
    includeUsage = false,
    groundingMetadata?: GoogleGroundingMetadata,
  ): GoogleGenerateContentResponse => {
    if (options.preserveAntigravityReasoning) {
      for (const part of parts) {
        if (part.functionCall) {
          textLength = 0
          thoughtText = ""
        } else if (part.thought) {
          thoughtText += part.text ?? ""
        } else {
          textLength += part.text?.length ?? 0
        }
      }
    }

    const usageMetadata =
      includeUsage && hasUsage ?
        translateAnthropicUsageToGoogle(usage)
      : undefined
    return {
      ...(responseId ? { responseId } : {}),
      modelVersion,
      candidates: [
        {
          index: 0,
          ...(parts.length > 0 ? { content: { role: "model", parts } } : {}),
          ...(finishReason ? { finishReason } : {}),
          ...(groundingMetadata ? { groundingMetadata } : {}),
        },
      ],
      ...(usageMetadata ? { usageMetadata } : {}),
    }
  }

  try {
    for await (const chunk of chunks) {
      if (!chunk.data || chunk.data === "[DONE]") continue

      const event = parseAnthropicEvent(chunk.data)
      if (event.type === "ping") continue

      if (event.type === "error") {
        throw new GoogleMessagesTranslationError(event.error.message, 502)
      }

      if (event.type === "message_start") {
        initialized = true
        responseId = event.message.id
        modelVersion = event.message.model || options.fallbackModel
        Object.assign(usage, event.message.usage)
        hasUsage = true
        continue
      }

      if (event.type === "content_block_start") {
        initialized = true
        const block = event.content_block
        if (pendingInvalidToolArgsError && block.type !== "thinking") {
          throw pendingInvalidToolArgsError
        }
        if (block.type === "thinking") {
          blocks.set(event.index, {
            type: "thinking",
            signature: "",
          })
          if (block.thinking.length > 0) {
            const flushed = takePendingSignatureParts()
            if (flushed.length > 0) {
              yield buildChunk(flushed)
            }
            yield buildChunk([{ text: block.thinking, thought: true }])
          }
        } else if (block.type === "text") {
          blocks.set(event.index, { type: "text" })
          if (block.text.length > 0) {
            yield buildChunk([{ text: block.text }])
          }
        } else if (block.type === "tool_use") {
          blocks.set(event.index, {
            type: "tool_use",
            id: block.id,
            name: block.name,
            inputJson: "",
            initialInput: isRecord(block.input) ? block.input : {},
          })
        } else if (block.type === "server_tool_use") {
          blocks.set(event.index, {
            type: "server_tool_use",
            name: block.name,
            inputJson: "",
            initialInput: isRecord(block.input) ? block.input : {},
          })
        } else if (block.type === "web_search_tool_result") {
          recordWebSearchResults(grounding, block.content)
        }
        continue
      }

      if (event.type === "content_block_delta") {
        initialized = true
        const block = blocks.get(event.index)
        const { delta } = event

        if (delta.type === "thinking_delta") {
          if (delta.thinking.length > 0) {
            const flushed = takePendingSignatureParts()
            if (flushed.length > 0) {
              yield buildChunk(flushed)
            }
            yield buildChunk([{ text: delta.thinking, thought: true }])
          }
        } else if (delta.type === "signature_delta") {
          if (block?.type === "thinking" && delta.signature.length > 0) {
            block.signature += delta.signature
          }
        } else if (delta.type === "text_delta") {
          if (delta.text.length > 0) {
            yield buildChunk([{ text: delta.text }])
          }
        } else if (delta.type === "input_json_delta") {
          if (block?.type === "tool_use" || block?.type === "server_tool_use") {
            block.inputJson += delta.partial_json
          }
        }
        continue
      }

      if (event.type === "content_block_stop") {
        const block = blocks.get(event.index)
        blocks.delete(event.index)
        if (!block) continue

        if (block.type === "thinking") {
          if (block.signature.length > 0) {
            if (
              options.preserveAntigravityReasoning
              && isResponsesThinkingSignature(block.signature)
            ) {
              antigravitySignatures.push([
                block.signature,
                textLength,
                thoughtText.length,
              ])
              continue
            }
            const encoded = encodeSignatureForGoogle(block.signature)
            if (encoded.target && typeof encoded.target === "object") {
              toolSignaturesById.set(
                encoded.target.toolUseId,
                encoded.signature,
              )
            } else {
              const flushed = takePendingSignatureParts()
              if (flushed.length > 0) {
                yield buildChunk(flushed)
              }
              pendingSignatures.push(encoded.signature)
            }
          }
        } else if (block.type === "tool_use") {
          let args: Record<string, unknown>
          try {
            args = parseToolUseArguments(block.inputJson, block.initialInput)
          } catch (error) {
            pendingInvalidToolArgsError =
              error instanceof GoogleMessagesTranslationError ? error : (
                new GoogleMessagesTranslationError(
                  `Invalid tool call arguments JSON in Messages stream: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                  502,
                )
              )
            continue
          }

          flushAntigravitySignatures(
            antigravitySignatures,
            pendingSignatures,
            thoughtText,
          )
          let thoughtSignature = toolSignaturesById.get(block.id)
          const precedingParts: Array<GooglePart> = []
          if (thoughtSignature) {
            toolSignaturesById.delete(block.id)
            precedingParts.push(...takePendingSignatureParts())
          } else if (pendingSignatures.length > 0) {
            while (pendingSignatures.length > 1) {
              const earlier = pendingSignatures.shift()
              if (earlier) {
                precedingParts.push({ text: "", thoughtSignature: earlier })
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
          if (precedingParts.length > 0) {
            yield buildChunk(precedingParts)
          }
          yield buildChunk([
            {
              functionCall: {
                id: block.id,
                name: block.name,
                args,
              },
              ...(thoughtSignature ? { thoughtSignature } : {}),
            },
          ])
        } else if (block.type === "server_tool_use") {
          if (block.name === "web_search") {
            try {
              const args = parseToolUseArguments(
                block.inputJson,
                block.initialInput,
              )
              recordWebSearchQuery(grounding, args)
            } catch {
              // Grounding metadata is best-effort for server tool inputs.
            }
          }
        }
        continue
      }

      if (event.type === "message_delta") {
        initialized = true
        stopReason = event.delta.stop_reason ?? null
        if (event.usage) {
          if (event.usage.input_tokens !== undefined) {
            usage.input_tokens = event.usage.input_tokens
          }
          if (event.usage.output_tokens !== undefined) {
            usage.output_tokens = event.usage.output_tokens
          }
          if (event.usage.cache_read_input_tokens !== undefined) {
            usage.cache_read_input_tokens = event.usage.cache_read_input_tokens
          }
          if (event.usage.cache_creation_input_tokens !== undefined) {
            usage.cache_creation_input_tokens =
              event.usage.cache_creation_input_tokens
          }
          hasUsage = true
        }
        continue
      }

      if (event.type === "message_stop") {
        if (pendingInvalidToolArgsError) {
          if (stopReason !== "max_tokens") {
            throw pendingInvalidToolArgsError
          }
          pendingInvalidToolArgsError = undefined
        }
        initialized = true
        messageStopped = true
        flushAntigravitySignatures(antigravitySignatures, pendingSignatures)
        const finalParts = takePendingSignatureParts()
        yield buildChunk(
          finalParts,
          mapAnthropicStopReasonToGoogle(stopReason),
          true,
          finalizeGroundingMetadata(grounding),
        )
        break
      }
    }

    if (options.signal?.aborted) {
      return
    }

    if (pendingInvalidToolArgsError) {
      throw pendingInvalidToolArgsError
    }

    if (!initialized) {
      throw new GoogleMessagesTranslationError(
        "Messages API returned an empty stream",
        502,
      )
    }

    if (!messageStopped) {
      throw new GoogleMessagesTranslationError(
        "Messages stream ended without a message_stop event",
        502,
      )
    }
  } catch (error) {
    if (options.signal?.aborted) {
      return
    }
    const status =
      error instanceof GoogleMessagesTranslationError ? error.status : 502
    const message =
      error instanceof Error ?
        error.message
      : "Google stream translation failed"
    yield createGoogleErrorPayload(status, message)
  }
}
