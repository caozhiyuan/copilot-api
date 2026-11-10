import consola from "consola"

import { createHandlerLogger, debugJson } from "~/lib/logger"
import { prepareResponsesContinuation } from "~/lib/responses-continuation"
import {
  readResponsesStreamEvent,
  type ResponsesStreamChunk,
} from "~/lib/responses-stream-event"
import type {
  ResponsesPayload,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import {
  createPooledWebSocketStream,
  type PooledWebSocketRequest,
  type PooledWebSocketStreamOptions,
} from "~/services/responses-websocket"

let logger: ReturnType<typeof createHandlerLogger> | undefined
const getLogger = () =>
  (logger ??= createHandlerLogger("responses-websocket-continuation"))

export async function* createContinuableResponsesWebSocketStream<
  TPayload extends ResponsesPayload,
  TChunk extends ResponsesStreamChunk,
>(
  request: PooledWebSocketRequest<TPayload>,
  options: PooledWebSocketStreamOptions<TChunk>,
  continuation: {
    sessionId: string | undefined
    clientSignal?: AbortSignal
  },
): AsyncGenerator<TChunk> {
  const { sessionId, clientSignal } = continuation
  if (!sessionId) {
    yield* createPooledWebSocketStream(request, options)
    return
  }

  let forceFull = false
  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex++) {
    let attempt:
      | ReturnType<typeof prepareResponsesContinuation<TPayload>>
      | undefined
    let responseStarted = false
    let retry = false
    const source = createPooledWebSocketStream(
      {
        ...request,
        preparePayload: (payload, connection) => {
          const prepared =
            request.preparePayload?.(payload, connection) ?? payload
          if (!connection) return prepared
          attempt = prepareResponsesContinuation(
            prepared,
            connection,
            forceFull,
            clientSignal,
          )
          logOutgoingContinuationPayload(attempt.payload)
          return attempt.payload
        },
      },
      options,
    )

    for await (const chunk of source) {
      const event = parseEvent(chunk)
      if (
        attempt?.usedPrevious
        && !responseStarted
        && !forceFull
        && isPreviousResponseMiss(event)
        && !clientSignal?.aborted
      ) {
        retry = true
        consola.debug(
          "Responses websocket continuation unavailable; retrying full input",
        )
        break
      }
      if (event) attempt?.observe(event)
      if (event?.type.startsWith("response.")) responseStarted = true
      try {
        yield chunk
      } finally {
        // The pool still holds this request's socket while yielding completion.
        if (event?.type === "response.completed") attempt?.finish()
      }
    }
    if (!retry) return
    forceFull = true
  }
}

function logOutgoingContinuationPayload(payload: ResponsesPayload): void {
  const previousResponseId = payload.previous_response_id
  if (typeof previousResponseId === "string" && previousResponseId) {
    debugJson(getLogger(), "Responses websocket continuation payload:", payload)
    return
  }
  getLogger().debug("full payload")
}

function parseEvent(chunk: ResponsesStreamChunk): ResponseStreamEvent | null {
  try {
    const event = readResponsesStreamEvent(chunk)
    return typeof event?.type === "string" ? event : null
  } catch {
    return null
  }
}

function isPreviousResponseMiss(event: ResponseStreamEvent | null): boolean {
  if (event?.type !== "error") return false
  const code = event.error?.code ?? event.code
  return (
    code === "previous_response_not_found"
    || (event.error?.param ?? event.param) === "previous_response_id"
  )
}
