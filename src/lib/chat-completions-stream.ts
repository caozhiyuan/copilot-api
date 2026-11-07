import type { ServerSentEventMessage } from "fetch-event-stream"

import { createHandlerLogger } from "./logger"
import type { ChatCompletionChunk } from "./types/chat-completions"

const logger = createHandlerLogger("chat-completions-stream")

interface ChatCompletionStreamEvent {
  message: ServerSentEventMessage
  completion: ChatCompletionChunk | null
}

/** Keep draining upstream for usage, but expose incomplete streams as failures. */
export async function* guardChatCompletionsStream(
  source: AsyncIterable<ServerSentEventMessage>,
): AsyncGenerator<ChatCompletionStreamEvent> {
  let doneSeen = false
  let errorSeen = false

  try {
    for await (const chunk of source) {
      if (chunk.data?.trim() === "[DONE]") {
        doneSeen = true
      }
      const data = parseChunkData(chunk.data)
      if (isErrorEvent(chunk.event, data)) {
        errorSeen = true
        // JSON-only errors also need an event type for request outcome tracking.
        yield { message: { ...chunk, event: "error" }, completion: null }
      } else {
        yield { message: chunk, completion: data as ChatCompletionChunk | null }
      }
    }
  } catch (error) {
    if (!doneSeen && !errorSeen) {
      logger.error("Upstream chat completion stream failed", error)
      yield streamError(
        "upstream_stream_error",
        "Upstream chat completion stream failed, retry your request.",
      )
    }
    return
  }

  if (!doneSeen && !errorSeen) {
    yield streamError(
      "incomplete_stream",
      "Upstream chat completion stream ended before [DONE], retry your request.",
    )
  }
}

function isErrorEvent(event: string | undefined, data: unknown): boolean {
  return (
    event === "error"
    || (typeof data === "object"
      && data !== null
      && "error" in data
      && data.error !== null
      && data.error !== undefined)
  )
}

function parseChunkData(data: string | undefined): unknown {
  if (!data || data.trim() === "[DONE]") return null

  try {
    return JSON.parse(data) as unknown
  } catch {
    return null
  }
}

function streamError(code: string, message: string): ChatCompletionStreamEvent {
  return {
    message: {
      event: "error",
      data: JSON.stringify({ error: { type: "api_error", code, message } }),
    },
    completion: null,
  }
}
