/**
 * Stream ID Synchronization for @ai-sdk/openai compatibility
 *
 * Problem: GitHub Copilot's Responses API returns different IDs for the same
 * item in 'added' vs 'done' events. This breaks @ai-sdk/openai which expects
 * consistent IDs across the stream lifecycle.
 *
 * Errors without this fix:
 * - "activeReasoningPart.summaryParts" undefined
 * - "text part not found"
 *
 * Use case: OpenCode (AI coding assistant) using Codex models (gpt-5.2-codex)
 * via @ai-sdk/openai provider requires the Responses API endpoint.
 */

interface StreamIdTracker {
  outputItems: Map<number, string>
  contentParts: Map<string, string>
  messageItems: Map<number, string>
}

interface StreamEventData {
  item?: {
    id?: string
    type?: string
    summary?: Array<unknown>
  }
  output_index?: number
  content_index?: number
  item_id?: string
  response?: {
    output?: Array<{
      type?: string
      summary?: Array<unknown>
    }>
  }
}

export const createStreamIdTracker = (): StreamIdTracker => ({
  outputItems: new Map(),
  contentParts: new Map(),
  messageItems: new Map(),
})

export const fixStreamIds = (
  data: string,
  event: string | undefined,
  tracker: StreamIdTracker,
): string => {
  if (!data) return data

  try {
    const parsed = JSON.parse(data) as StreamEventData

    switch (event) {
      case "response.output_item.added": {
        return handleOutputItemAdded(parsed, tracker)
      }
      case "response.output_item.done": {
        return handleOutputItemDone(parsed, tracker)
      }
      case "response.content_part.added": {
        return handleContentPartAdded(parsed, tracker)
      }
      case "response.content_part.done": {
        return handleContentPartDone(parsed, tracker)
      }
      case "response.output_text.delta":
      case "response.output_text.done": {
        return handleOutputText(parsed, tracker)
      }
      case "response.completed":
      case "response.incomplete": {
        return handleResponseCompleted(parsed)
      }
      default: {
        return data
      }
    }
  } catch {
    return data
  }
}

const handleOutputItemAdded = (
  parsed: StreamEventData,
  tracker: StreamIdTracker,
): string => {
  if (!parsed.item?.id) return JSON.stringify(parsed)

  const outputIndex = parsed.output_index ?? 0
  tracker.outputItems.set(outputIndex, parsed.item.id)

  if (parsed.item.type === "message") {
    tracker.messageItems.set(outputIndex, parsed.item.id)
  }
  if (
    parsed.item.type === "reasoning"
    && Array.isArray(parsed.item.summary)
    && parsed.item.summary.length === 0
  ) {
    delete parsed.item.summary
  }
  return JSON.stringify(parsed)
}

const handleOutputItemDone = (
  parsed: StreamEventData,
  tracker: StreamIdTracker,
): string => {
  if (!parsed.item) return JSON.stringify(parsed)

  const outputIndex = parsed.output_index ?? 0
  const originalId = tracker.outputItems.get(outputIndex)
  if (originalId) {
    parsed.item.id = originalId
  }
  if (
    parsed.item.type === "reasoning"
    && Array.isArray(parsed.item.summary)
    && parsed.item.summary.length === 0
  ) {
    delete parsed.item.summary
  }
  return JSON.stringify(parsed)
}

const handleContentPartAdded = (
  parsed: StreamEventData,
  tracker: StreamIdTracker,
): string => {
  const outputIndex = parsed.output_index ?? 0
  const contentIndex = parsed.content_index ?? 0
  const key = `${outputIndex}:${contentIndex}`

  if (parsed.item_id) {
    tracker.contentParts.set(key, parsed.item_id)
  }

  const messageId = tracker.messageItems.get(outputIndex)
  if (messageId) {
    parsed.item_id = messageId
  }
  return JSON.stringify(parsed)
}

const handleContentPartDone = (
  parsed: StreamEventData,
  tracker: StreamIdTracker,
): string => {
  const outputIndex = parsed.output_index ?? 0
  const contentIndex = parsed.content_index ?? 0
  const key = `${outputIndex}:${contentIndex}`

  const messageId = tracker.messageItems.get(outputIndex)
  if (messageId) {
    parsed.item_id = messageId
  } else {
    const originalItemId = tracker.contentParts.get(key)
    if (originalItemId) {
      parsed.item_id = originalItemId
    }
  }

  tracker.contentParts.delete(key)
  return JSON.stringify(parsed)
}

const handleOutputText = (
  parsed: StreamEventData,
  tracker: StreamIdTracker,
): string => {
  const outputIndex = parsed.output_index ?? 0
  const messageId = tracker.messageItems.get(outputIndex)
  if (messageId) {
    parsed.item_id = messageId
  }
  return JSON.stringify(parsed)
}

const handleResponseCompleted = (parsed: StreamEventData): string => {
  if (!parsed.response?.output) return JSON.stringify(parsed)

  for (const item of parsed.response.output) {
    if (
      item.type === "reasoning"
      && Array.isArray(item.summary)
      && item.summary.length === 0
    ) {
      delete item.summary
    }
  }
  return JSON.stringify(parsed)
}
