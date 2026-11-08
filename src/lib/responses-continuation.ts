import { createHash } from "node:crypto"

import { requestContext } from "~/lib/request-context"
import {
  deleteResponseContinuation,
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
const trackedConnections = new WeakSet<PooledWebSocketConnection>()
const MAX_AGE_MS = 60 * 60 * 1000

// Trace affinity identifies the current agent, independently of its root group.
export function getResponsesContinuationSession(): string | undefined {
  return requestContext.getStore()?.sessionAffinity?.trim() || undefined
}

// Sort object keys, but preserve every field, array order and encrypted block.
// A protocol/ID round trip that cannot be matched exactly uses the full input.
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

export function prepareResponsesContinuation<T extends ResponsesPayload>(
  payload: T,
  connection: PooledWebSocketConnection,
  scopeKey: string,
  sessionId: string,
  forceFull: boolean,
  clientSignal?: AbortSignal,
) {
  if (!trackedConnections.has(connection)) {
    trackedConnections.add(connection)
    connection.onClose(() => {
      states.delete(connection)
      deleteResponseContinuation(connection.id)
    })
  }

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
      && previous
      && previous.scopeKey === scopeKey
      && previous.expiresAt > Date.now()
      && previous.requestHash === requestHash
      && input.length >= previous.prefixItemCount
      && hashResponseContext(input.slice(0, previous.prefixItemCount))
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
  let completed = false
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
        prefixHash: hashResponseContext([...input, ...output]),
        expiresAt: Date.now() + MAX_AGE_MS,
      }
      completed = true
      states.set(connection, record)
      saveResponseContinuation(record)
    },
    finish(): void {
      if (!completed || clientSignal?.aborted) {
        states.delete(connection)
        deleteResponseContinuation(connection.id)
      }
    },
  }
}
