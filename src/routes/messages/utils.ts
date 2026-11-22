import { type AnthropicResponse } from "~/lib/types/anthropic"

export function mapOpenAIStopReasonToAnthropic(
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): AnthropicResponse["stop_reason"] {
  if (finishReason === null) {
    return null
  }
  const stopReasonMap = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "end_turn",
  } as const
  return stopReasonMap[finishReason]
}

// Copilot's Gemini models sometimes end a turn after emitting only these image
// control tokens as text. Callers turn such a turn into a retryable error.
const IMAGE_CONTROL_TOKENS = ["<start_of_image>", "<end_of_image>"]
const IMAGE_CONTROL_TOKEN_ONLY_PATTERN =
  /^\s*(?:<(?:start|end)_of_image>\s*)+$/u
const LEADING_IMAGE_CONTROL_RUN_PATTERN =
  /^\s{0,64}(?:<(?:start|end)_of_image>\s*)*/u
const MAX_HELD_IMAGE_CONTROL_CHARS = 4_096

export function isImageControlTokenOnly(text: string): boolean {
  return IMAGE_CONTROL_TOKEN_ONLY_PATTERN.test(text)
}

export function mayBeImageControlTokenOnly(text: string): boolean {
  if (text.length > MAX_HELD_IMAGE_CONTROL_CHARS) {
    return false
  }
  const rest = text.replace(LEADING_IMAGE_CONTROL_RUN_PATTERN, "")
  return IMAGE_CONTROL_TOKENS.some((token) => token.startsWith(rest))
}
