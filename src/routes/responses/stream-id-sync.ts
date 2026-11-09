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

import type { ResponsesStreamChunk } from "~/lib/responses-stream-event"
import type {
  ResponseOutputItem,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponsesResult,
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

export const createCopilotResponsesSseMessage = (
  { data: rawData, event, id: chunkId }: ResponsesStreamChunk,
  parsed: ResponseStreamEvent | null,
  tracker: StreamIdTracker,
) => {
  const data = rawData ?? ""
  const id = typeof chunkId === "number" ? String(chunkId) : chunkId
  if (!data || data === "[DONE]") return { data, event, id }
  if (parsed === null) throw new TypeError("Invalid Copilot Responses event")

  const normalized = fixStreamIds(parsed, event, tracker)
  return {
    data: normalized === parsed ? data : JSON.stringify(normalized),
    event,
    id,
  }
}

const fixStreamIds = (
  parsed: ResponseStreamEvent,
  event: string | undefined,
  tracker: StreamIdTracker,
): ResponseStreamEvent => {
  let normalized = parsed
  if ("response" in parsed) {
    const response = synchronizeResponse(parsed.response, tracker)
    if (response !== parsed.response) {
      normalized = { ...parsed, response }
    }
  }

  switch (event ?? normalized.type) {
    case "response.output_item.added":
    case "response.output_item.done": {
      const itemEvent = normalized as
        | ResponseOutputItemAddedEvent
        | ResponseOutputItemDoneEvent
      const item = synchronizeOutputItem(
        itemEvent.item,
        itemEvent.output_index,
        tracker,
        itemEvent.type === "response.output_item.done",
      )
      return item === itemEvent.item ? itemEvent : { ...itemEvent, item }
    }
    default: {
      return synchronizeItemId(normalized, tracker)
    }
  }
}

const synchronizeResponse = (
  response: ResponsesResult,
  tracker: StreamIdTracker,
): ResponsesResult => {
  const id = tracker.responseId || response.id
  if (id) tracker.responseId = id

  let output: Array<ResponseOutputItem> | undefined
  for (const [outputIndex, item] of (response.output ?? []).entries()) {
    const normalized = synchronizeOutputItem(item, outputIndex, tracker)
    if (normalized !== item) {
      output ??= response.output.slice()
      output[outputIndex] = normalized
    }
  }

  return id === response.id && output === undefined ?
      response
    : { ...response, id, output: output ?? response.output }
}

const synchronizeOutputItem = (
  item: ResponseOutputItem,
  outputIndex: number,
  tracker: StreamIdTracker,
  isDone = false,
): ResponseOutputItem => {
  let itemId = tracker.outputItems.get(outputIndex) ?? item.id
  if (!itemId) {
    let randomSuffix = ""
    while (randomSuffix.length < 16) {
      randomSuffix += Math.random().toString(36).slice(2)
    }
    itemId = `oi_${outputIndex}_${randomSuffix.slice(0, 16)}`
  }

  tracker.outputItems.set(outputIndex, itemId)

  if (item.type === "compaction") {
    // Copilot can rewrap the same checkpoint in the completed snapshot.
    // Clients have already accepted item.done, so preserve its ciphertext.
    const encryptedContent = tracker.completedCompactions.get(outputIndex)
    if (encryptedContent !== undefined) {
      if (encryptedContent !== item.encrypted_content) {
        return { ...item, id: itemId, encrypted_content: encryptedContent }
      }
    } else if (isDone) {
      tracker.completedCompactions.set(outputIndex, item.encrypted_content)
    }
  }

  return item.id === itemId ? item : { ...item, id: itemId }
}

const synchronizeItemId = (
  parsed: ResponseStreamEvent & { output_index?: number; item_id?: string },
  tracker: StreamIdTracker,
): typeof parsed => {
  const { output_index: outputIndex } = parsed
  const itemId =
    outputIndex === undefined ? undefined : tracker.outputItems.get(outputIndex)
  return itemId && itemId !== parsed.item_id ?
      { ...parsed, item_id: itemId }
    : parsed
}
