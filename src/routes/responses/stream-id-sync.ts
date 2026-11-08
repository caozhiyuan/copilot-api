/**
 * Stream ID Synchronization for Responses client compatibility
 *
 * Problem: GitHub Copilot's Responses API returns different IDs for the same
 * response and output item across lifecycle events and response snapshots.
 * Responses clients, including OpenCode compaction, require consistent IDs.
 * Apply this only to downstream JSON: WebSocket continuation keeps the original
 * upstream response.completed ID for previous_response_id.
 *
 * Errors without this fix:
 * - "activeReasoningPart.summaryParts" undefined
 * - "text part not found"
 *
 * Use case: OpenCode (AI coding assistant) using Codex models (gpt-5.2-codex)
 * via @ai-sdk/openai provider requires the Responses API endpoint.
 */

import type {
  ResponseOutputItem,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseStreamEvent,
} from "~/lib/types/responses"

interface StreamIdTracker {
  responseId?: string
  outputItems: Map<number, string>
  completedCompactions: Map<number, string>
}

export const createStreamIdTracker = (): StreamIdTracker => ({
  outputItems: new Map(),
  completedCompactions: new Map(),
})

export const fixStreamIds = (
  data: string,
  event: string | undefined,
  tracker: StreamIdTracker,
): string => {
  if (!data || data === "[DONE]") return data
  const parsed = JSON.parse(data) as ResponseStreamEvent
  if ("response" in parsed) {
    const { response } = parsed
    if (tracker.responseId) {
      response.id = tracker.responseId
    } else if (response.id) {
      tracker.responseId = response.id
    }
    for (const [outputIndex, item] of (response.output ?? []).entries()) {
      synchronizeOutputItem(item, outputIndex, tracker)
    }
  }

  switch (event ?? parsed.type) {
    case "response.output_item.added":
    case "response.output_item.done": {
      const itemEvent = parsed as
        | ResponseOutputItemAddedEvent
        | ResponseOutputItemDoneEvent
      synchronizeOutputItem(
        itemEvent.item,
        itemEvent.output_index,
        tracker,
        itemEvent.type === "response.output_item.done",
      )
      return JSON.stringify(parsed)
    }
    default: {
      return handleItemId(parsed, tracker)
    }
  }
}

const synchronizeOutputItem = (
  item: ResponseOutputItem,
  outputIndex: number,
  tracker: StreamIdTracker,
  isDone = false,
): void => {
  let itemId = tracker.outputItems.get(outputIndex) ?? item.id
  if (!itemId) {
    let randomSuffix = ""
    while (randomSuffix.length < 16) {
      randomSuffix += Math.random().toString(36).slice(2)
    }
    itemId = `oi_${outputIndex}_${randomSuffix.slice(0, 16)}`
  }

  item.id = itemId
  tracker.outputItems.set(outputIndex, itemId)

  if (item.type === "compaction") {
    // Copilot can rewrap the same checkpoint in the completed snapshot.
    // Clients have already accepted item.done, so preserve its ciphertext.
    const encryptedContent = tracker.completedCompactions.get(outputIndex)
    if (encryptedContent !== undefined) {
      item.encrypted_content = encryptedContent
    } else if (isDone) {
      tracker.completedCompactions.set(outputIndex, item.encrypted_content)
    }
  }
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
