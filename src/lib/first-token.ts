import { requestContext } from "~/lib/request-context"
import type { AnthropicStreamEventData } from "~/lib/types/anthropic"
import type { ChatCompletionChunk } from "~/lib/types/chat-completions"
import type { GoogleGenerateContentResponse } from "~/lib/types/google"
import type { ResponseStreamEvent } from "~/lib/types/responses"

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0

// Observe events already parsed by stream handlers. Never read or parse a stream
// here, and never expose its content to plugins. Explicit thinking starts count
// even before text is exposed. Whitespace is also valid output.
export function recordChatCompletionFirstToken(
  chunk: ChatCompletionChunk | null,
): void {
  const observer =
    requestContext.getStore()?.requestTiming
    ?? requestContext.getStore()?.pluginRequest
  if (!observer || !chunk) return
  if (
    chunk.choices?.some(
      ({ delta }) =>
        delta
        && (nonempty(delta.content)
          || nonempty(delta.reasoning_text)
          || nonempty(delta.reasoning_content)
          || nonempty(delta.reasoning)
          || delta.tool_calls?.some((tool) =>
            nonempty(tool.function?.arguments),
          )),
    )
  ) {
    observer.recordFirstToken()
  }
}

export function recordResponsesFirstToken(
  event: ResponseStreamEvent | null,
): void {
  const observer =
    requestContext.getStore()?.requestTiming
    ?? requestContext.getStore()?.pluginRequest
  if (!observer || !event) return
  switch (event.type) {
    case "response.output_item.added":
      if (event.item?.type === "reasoning") observer.recordFirstToken()
      break
    case "response.reasoning_summary_part.added":
      observer.recordFirstToken()
      break
    case "response.output_text.delta":
    case "response.reasoning_summary_text.delta":
    case "response.function_call_arguments.delta":
    case "response.custom_tool_call_input.delta":
      if (nonempty(event.delta)) observer.recordFirstToken()
  }
}

export function recordAnthropicFirstToken(
  event: AnthropicStreamEventData | null,
): void {
  const observer =
    requestContext.getStore()?.requestTiming
    ?? requestContext.getStore()?.pluginRequest
  if (!observer || !event) return
  if (event.type === "content_block_delta") {
    const { delta } = event
    if (
      (delta.type === "text_delta" && nonempty(delta.text))
      || (delta.type === "thinking_delta" && nonempty(delta.thinking))
      || (delta.type === "input_json_delta" && nonempty(delta.partial_json))
    ) {
      observer.recordFirstToken()
    }
  } else if (event.type === "content_block_start") {
    const block = event.content_block
    if (
      (block.type === "text" && nonempty(block.text))
      || block.type === "thinking"
      || ((block.type === "tool_use" || block.type === "server_tool_use")
        && block.input
        && Object.keys(block.input).length > 0)
    ) {
      observer.recordFirstToken()
    }
  }
}

export function recordGoogleFirstToken(
  response: GoogleGenerateContentResponse,
): void {
  const observer =
    requestContext.getStore()?.requestTiming
    ?? requestContext.getStore()?.pluginRequest
  if (!observer) return
  if (
    response.candidates?.some((candidate) =>
      candidate.content?.parts.some(
        (part) =>
          part.thought === true
          || nonempty(part.text)
          || nonempty(part.functionCall?.name),
      ),
    )
  ) {
    // Google's functionCall part carries a complete generated call, rather than
    // an empty tool-start envelope followed by argument deltas.
    observer.recordFirstToken()
  }
}
