import { createHash } from "node:crypto"

import { requestContext } from "~/lib/request-context"
import type {
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
  ResponsesPayload,
} from "~/lib/types/responses"
import type { PooledWebSocketConnection } from "~/services/responses-websocket"

type ContinuationItem = ResponseInputItem | ResponseOutputItem

interface ContinuationAnchor {
  type:
    | "function_call"
    | "custom_tool_call"
    | "tool_search_call"
    | "reasoning"
    | "assistant_text"
  value: string
}

interface ContinuationState {
  responseId: string
  anchor: ContinuationAnchor
  compactionHash: string | null
}

interface OutputMarker {
  anchor: ContinuationAnchor | undefined
  textAnchor: ContinuationAnchor | undefined
  assistant: boolean
}

const states = new WeakMap<PooledWebSocketConnection, ContinuationState>()

// Trace affinity identifies the current agent, independently of its root group.
export function getResponsesContinuationSession(): string | undefined {
  return requestContext.getStore()?.sessionAffinity?.trim() || undefined
}

function getAnchor(item: ContinuationItem): ContinuationAnchor | undefined {
  if (item.type === "reasoning") {
    if (typeof item.encrypted_content === "string" && item.encrypted_content)
      return { type: item.type, value: item.encrypted_content }
  } else if (
    item.type === "function_call"
    || item.type === "custom_tool_call"
    || item.type === "tool_search_call"
  ) {
    if (typeof item.call_id === "string" && item.call_id)
      return { type: item.type, value: item.call_id }
  }
  return undefined
}

function isAssistantItem(item: ContinuationItem): boolean {
  const type = item.type
  return (
    ("role" in item && item.role === "assistant")
    || (typeof type === "string" && type.endsWith("_call"))
    || type === "reasoning"
    || type === "compaction"
    || type === "mcp_list_tools"
    || type === "mcp_approval_request"
    || type === "program"
    || type === "program_output"
    || (type === "tool_search_output" && item.execution === "server")
  )
}

function getTextAnchor(item: ContinuationItem): ContinuationAnchor | undefined {
  if (
    !("role" in item)
    || item.role !== "assistant"
    || (item.type !== undefined && item.type !== "message")
  )
    return undefined
  const content: unknown = item.content
  let text = ""
  if (typeof content === "string") {
    text = content
  } else if (Array.isArray(content)) {
    const blocks: ReadonlyArray<unknown> = content
    for (const block of blocks) {
      if (!block || typeof block !== "object" || !("type" in block))
        return undefined
      if (
        (block.type === "output_text" || block.type === "input_text")
        && "text" in block
        && typeof block.text === "string"
      )
        text += block.text
      else if (
        block.type === "refusal"
        && "refusal" in block
        && typeof block.refusal === "string"
      )
        text += block.refusal
      else return undefined
    }
  }
  return text ?
      {
        type: "assistant_text",
        value: createHash("sha256").update(text).digest("hex"),
      }
    : undefined
}

// SHA-256 of the latest compaction ciphertext. Null when that item is absent
// or has no string ciphertext. The ciphertext itself is not retained.
function hashCompactionCheckpoint(
  input: ReadonlyArray<ResponseInputItem>,
): string | null {
  const item = input.findLast(
    (candidate) => "type" in candidate && candidate.type === "compaction",
  )
  if (
    !item
    || !("encrypted_content" in item)
    || typeof item.encrypted_content !== "string"
  )
    return null
  return createHash("sha256").update(item.encrypted_content).digest("hex")
}

function findDeltaStart(
  input: ReadonlyArray<ResponseInputItem>,
  anchor: ContinuationAnchor,
): number {
  const index =
    anchor.type === "assistant_text" ?
      input.findLastIndex((item) => "role" in item && item.role === "assistant")
    : input.findLastIndex((item) => {
        const candidate = getAnchor(item)
        return (
          candidate?.type === anchor.type && candidate.value === anchor.value
        )
      })
  if (index < 0) return -1
  if (
    anchor.type === "assistant_text"
    && getTextAnchor(input[index])?.value !== anchor.value
  )
    return -1
  let start = index + 1
  while (start < input.length && isAssistantItem(input[start])) start += 1
  return start < input.length ? start : -1
}

export function prepareResponsesContinuation<T extends ResponsesPayload>(
  payload: T,
  connection: PooledWebSocketConnection,
  forceFull: boolean,
  clientSignal?: AbortSignal,
) {
  const previous = states.get(connection)
  const { input, previous_response_id: explicitPrevious } = payload
  const eligible =
    Array.isArray(input)
    && explicitPrevious == null
    && payload.generate !== false
  // Compare the checkpoint before slicing so a surviving anchor cannot drop it.
  const compactionHash =
    Array.isArray(input) ? hashCompactionCheckpoint(input) : null
  const start =
    (
      eligible
      && explicitPrevious === undefined
      && !forceFull
      && !connection.closed
      && previous
      && previous.compactionHash === compactionHash
    ) ?
      findDeltaStart(input, previous.anchor)
    : -1
  const outgoing =
    start >= 0 && previous && Array.isArray(input) ?
      {
        ...payload,
        previous_response_id: previous.responseId,
        input: input.slice(start),
      }
    : payload
  // Retain opaque anchors or text hashes and roles, never output text.
  const outputItems = new Map<number, OutputMarker>()
  let candidate: ContinuationState | null | undefined
  let interruptedTerminal = false
  const markOutput = (item: ContinuationItem): OutputMarker => ({
    anchor: getAnchor(item),
    textAnchor: getTextAnchor(item),
    assistant: isAssistantItem(item),
  })

  return {
    payload: outgoing,
    usedPrevious: outgoing !== payload,
    observe(event: ResponseStreamEvent): void {
      if (event.type === "response.output_item.done") {
        outputItems.set(event.output_index, markOutput(event.item))
      }
      if (
        event.type !== "response.completed"
        && event.type !== "response.incomplete"
      )
        return
      const interrupted =
        event.type === "response.incomplete"
        && event.response?.status === "incomplete"
        && event.response.incomplete_details?.reason === "interrupted"
      const completed =
        event.type === "response.completed"
        && event.response?.status === "completed"
        && !clientSignal?.aborted
      // An interrupted turn advances server history too. Never retry its parent
      // if this response lacks an anchor that the client can replay.
      if (interrupted) states.delete(connection)
      if (connection.closed || (!completed && !interrupted)) return

      interruptedTerminal = interrupted
      // A terminal response without a replayable anchor invalidates its parent.
      candidate = null
      if (!eligible || !event.response.id) return
      if (!Array.isArray(event.response.output) && outputItems.size === 0)
        return
      // Clients replay item.done, whose opaque signature can differ from the
      // terminal response. Terminal output only fills missing item markers.
      for (const [index, item] of (event.response.output ?? []).entries()) {
        if (!outputItems.has(index)) outputItems.set(index, markOutput(item))
      }
      const output = [...outputItems.entries()].sort(([a], [b]) => a - b)
      if (output.some(([index], i) => index !== i)) return
      let anchor: ContinuationAnchor | undefined
      let textAnchor: ContinuationAnchor | undefined
      for (const [, item] of output) {
        if (item.anchor) anchor = item.anchor
        else if (!item.assistant) anchor = undefined
        textAnchor = item.textAnchor
      }
      anchor ??= textAnchor
      if (anchor)
        candidate = {
          responseId: event.response.id,
          anchor,
          compactionHash,
        }
    },
    finish(): void {
      if (
        !connection.closed
        && (interruptedTerminal || !clientSignal?.aborted)
      ) {
        if (candidate) states.set(connection, candidate)
        else if (candidate === null) states.delete(connection)
      }
    },
  }
}
