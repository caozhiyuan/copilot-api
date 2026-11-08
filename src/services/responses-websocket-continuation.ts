import consola from "consola"

import { prepareResponsesContinuation } from "~/lib/responses-continuation"
import type {
  ResponsesPayload,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import {
  createPooledWebSocketStream,
  type PooledWebSocketRequest,
  type PooledWebSocketStreamOptions,
} from "~/services/responses-websocket"

interface StreamChunk {
  data?: string
  event?: string
}

export async function* createContinuableResponsesWebSocketStream<
  TPayload extends ResponsesPayload,
  TChunk extends StreamChunk,
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
            sessionId,
            forceFull,
            clientSignal,
          )
          return attempt.payload
        },
      },
      options,
    )

    try {
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
        yield chunk
      }
    } finally {
      attempt?.finish()
    }
    if (!retry) return
    forceFull = true
  }
}

function parseEvent(chunk: StreamChunk): ResponseStreamEvent | null {
  if (!chunk.data || chunk.data === "[DONE]") return null
  try {
    const parsed: unknown = JSON.parse(chunk.data)
    return (
        parsed
          && typeof parsed === "object"
          && "type" in parsed
          && typeof parsed.type === "string"
      ) ?
        (parsed as ResponseStreamEvent)
      : null
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
