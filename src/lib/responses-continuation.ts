import { createHash } from "node:crypto"

import { requestContext } from "~/lib/request-context"
import {
  saveResponseContinuation,
  type ResponseContinuationRecord,
} from "~/lib/response-continuation-store"
import type {
  ResponseStreamEvent,
  ResponsesPayload,
} from "~/lib/types/responses"
import type { PooledWebSocketConnection } from "~/services/responses-websocket"

const states = new WeakMap<
  PooledWebSocketConnection,
  ResponseContinuationRecord
>()
const MAX_AGE_MS = 60 * 60 * 1000
const ITEM_METADATA_TYPES = new Set([
  "message",
  "agent_message",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "tool_search_call",
  "tool_search_output",
  "web_search_call",
  "compaction",
  "compaction_trigger",
  "additional_tools",
])

// Trace affinity identifies the current agent, independently of its root group.
export function getResponsesContinuationSession(): string | undefined {
  return requestContext.getStore()?.sessionAffinity?.trim() || undefined
}

// Request settings preserve every field; input items normalize replay metadata
// separately, without changing the payload sent to the upstream.
export function hashResponseContext(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item))
          return item
        return Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      }),
    )
    .digest("hex")
}

function hashResponseInput(items: ReadonlyArray<unknown>): string {
  return hashResponseContext(
    items.map((item) => {
      if (!item || typeof item !== "object") return item
      const type =
        "type" in item ? item.type
        : "role" in item ? "message"
        : undefined
      if (typeof type !== "string" || !ITEM_METADATA_TYPES.has(type))
        return item
      const {
        id: _id,
        status: _status,
        internal_chat_message_metadata_passthrough: _metadata,
        ...context
      } = item as Record<string, unknown>
      if (type !== "message") return context
      const content =
        typeof context.content === "string" ?
          [{ type: "output_text", text: context.content }]
        : Array.isArray(context.content) ?
          context.content.map((part: unknown) => {
            if (
              !part
              || typeof part !== "object"
              || !("type" in part)
              || (part.type !== "input_text" && part.type !== "output_text")
            )
              return part
            const {
              annotations: _annotations,
              logprobs: _logprobs,
              ...text
            } = part as Record<string, unknown>
            return { ...text, type: "output_text" }
          })
        : context.content
      return { ...context, type, content }
    }),
  )
}

export function prepareResponsesContinuation<T extends ResponsesPayload>(
  payload: T,
  connection: PooledWebSocketConnection,
  scopeKey: string,
  sessionId: string,
  forceFull: boolean,
  clientSignal?: AbortSignal,
) {
  // The pool owns the connection lifetime; closed entries cannot be reused and
  // their continuation state is reclaimed with the entry by the WeakMap.
  const previous = states.get(connection)
  states.delete(connection)
  const {
    input,
    previous_response_id: explicitPrevious,
    client_metadata: _metadata,
    initiator: _initiator,
    ...config
  } = payload
  const requestHash = hashResponseContext(config)
  const eligible =
    Array.isArray(input)
    && explicitPrevious == null
    && payload.generate !== false
  const usePrevious = Boolean(
    eligible
      && explicitPrevious === undefined
      && !forceFull
      && !connection.closed
      && previous
      && previous.scopeKey === scopeKey
      && previous.expiresAt > Date.now()
      && previous.requestHash === requestHash
      && input.length >= previous.prefixItemCount
      && hashResponseInput(input.slice(0, previous.prefixItemCount))
        === previous.prefixHash,
  )
  const outgoing =
    usePrevious && previous && Array.isArray(input) ?
      {
        ...payload,
        previous_response_id: previous.responseId,
        input: input.slice(previous.prefixItemCount),
      }
    : payload
  const outputItems = new Map<number, unknown>()

  return {
    payload: outgoing,
    usedPrevious: usePrevious,
    observe(event: ResponseStreamEvent): void {
      if (event.type === "response.output_item.done") {
        outputItems.set(event.output_index, event.item)
      }
      if (event.type !== "response.completed") return
      if (
        !eligible
        || connection.closed
        || clientSignal?.aborted
        || event.response?.status !== "completed"
        || !event.response.id
      )
        return

      const output =
        event.response.output?.length ? event.response.output
        : outputItems.size > 0 ?
          [...outputItems.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, item]) => item)
        : event.response.output
      if (!Array.isArray(output)) return
      if (
        !event.response.output?.length
        && [...outputItems.keys()]
          .sort((a, b) => a - b)
          .some((index, i) => index !== i)
      )
        return
      const record: ResponseContinuationRecord = {
        connectionId: connection.id,
        scopeKey,
        sessionId,
        responseId: event.response.id,
        requestHash,
        prefixItemCount: input.length + output.length,
        prefixHash: hashResponseInput([...input, ...output]),
        expiresAt: Date.now() + MAX_AGE_MS,
      }
      states.set(connection, record)
      saveResponseContinuation(record)
    },
    finish(): void {
      if (clientSignal?.aborted) states.delete(connection)
    },
  }
}
