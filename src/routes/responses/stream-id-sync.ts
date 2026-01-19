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

import type {
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseStreamEvent,
} from "~/services/copilot/create-responses"

interface StreamIdTracker {
  outputItems: Map<number, string>
}

export const createStreamIdTracker = (): StreamIdTracker => ({
  outputItems: new Map(),
})

export const fixStreamIds = (
  data: string,
  event: string | undefined,
  tracker: StreamIdTracker,
): string => {
  if (!data) return data
  const parsed = JSON.parse(data) as ResponseStreamEvent
  switch (event) {
    case "response.output_item.added": {
      return handleOutputItemAdded(
        parsed as ResponseOutputItemAddedEvent,
        tracker,
      )
    }
    case "response.output_item.done": {
      return handleOutputItemDone(
        parsed as ResponseOutputItemDoneEvent,
        tracker,
      )
    }
    default: {
      return handleItemId(parsed, tracker)
    }
  }
}

const handleOutputItemAdded = (
  parsed: ResponseOutputItemAddedEvent,
  tracker: StreamIdTracker,
): string => {
  if (!parsed.item.id) {
    let randomSuffix = ""
    while (randomSuffix.length < 16) {
      randomSuffix += Math.random().toString(36).slice(2)
    }
    parsed.item.id = `oi_${parsed.output_index}_${randomSuffix.slice(0, 16)}`
  }

  const outputIndex = parsed.output_index
  tracker.outputItems.set(outputIndex, parsed.item.id)
  return JSON.stringify(parsed)
}

const handleOutputItemDone = (
  parsed: ResponseOutputItemDoneEvent,
  tracker: StreamIdTracker,
): string => {
  const outputIndex = parsed.output_index
  const originalId = tracker.outputItems.get(outputIndex)
  if (originalId) {
    parsed.item.id = originalId
  }
  return JSON.stringify(parsed)
}

const handleItemId = (
  parsed: ResponseStreamEvent & { output_index?: number; item_id?: string },
  tracker: StreamIdTracker,
): string => {
  const outputIndex = parsed.output_index
  if (outputIndex !== undefined) {
    const itemId = tracker.outputItems.get(outputIndex)
    if (itemId) {
      parsed.item_id = itemId
    }
  }
  return JSON.stringify(parsed)
}
