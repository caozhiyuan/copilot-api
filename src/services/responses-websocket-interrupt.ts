import consola from "consola"

import {
  readResponsesStreamEvent,
  type ResponsesStreamChunk,
} from "~/lib/responses-stream-event"

const INTERRUPT_TIMEOUT_MS = 10000

export function createResponsesWebSocketInterruption(
  clientSignal: AbortSignal,
  send: (message: string) => void,
) {
  const failure = new AbortController()
  let responseId: string | undefined
  let status: "unsent" | "pending" | "accepted" = "unsent"
  let terminal = false
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let wakeWaiter: (() => void) | undefined

  const fail = (message: string) => {
    consola.debug(message)
    failure.abort()
  }

  const sendInterrupt = () => {
    if (!deadlineTimer || !responseId || status !== "unsent" || terminal) return
    status = "pending"
    try {
      send(
        JSON.stringify({
          type: "response.interrupt",
          response_id: responseId,
          mode: "discard_partial_items",
        }),
      )
      consola.debug("Sent Responses websocket response.interrupt")
    } catch {
      fail("Failed to send Responses websocket response.interrupt")
    }
  }

  const onClientAbort = () => {
    if (terminal || deadlineTimer) return
    deadlineTimer = setTimeout(() => {
      fail("Timed out waiting for Responses websocket interruption")
    }, INTERRUPT_TIMEOUT_MS)
    sendInterrupt()
  }

  return {
    failureSignal: failure.signal,
    get awaitingAcknowledgement() {
      return status === "pending"
    },
    start() {
      clientSignal.addEventListener("abort", onClientAbort, { once: true })
      if (clientSignal.aborted) onClientAbort()
    },
    waitForRelease(nextClientSignal: AbortSignal): Promise<void> | undefined {
      if (!deadlineTimer || wakeWaiter) return
      const signal = AbortSignal.any([nextClientSignal, failure.signal])
      if (signal.aborted) return
      const { promise, resolve } = Promise.withResolvers<void>()
      const wake = () => resolve()
      wakeWaiter = wake
      signal.addEventListener("abort", wake, { once: true })
      return promise.finally(() => signal.removeEventListener("abort", wake))
    },
    observe(chunk: ResponsesStreamChunk): boolean {
      const { event: type } = chunk
      if (type === "response.created" && !responseId) {
        const event = readResponsesStreamEvent(chunk)
        if (event?.type === "response.created") {
          const id = event.response?.id
          if (typeof id === "string" && id) responseId = id
        }
        sendInterrupt()
      }
      if (
        type !== "response.interrupt.accepted"
        && type !== "response.interrupt.failed"
      )
        return false

      if (status === "pending") {
        const event = readResponsesStreamEvent(chunk)
        if (
          type === "response.interrupt.accepted"
          && event
          && "response_id" in event
          && event.response_id === responseId
        ) {
          status = "accepted"
          consola.debug(
            "Received matching Responses websocket interrupt acknowledgement",
          )
        } else {
          fail("Responses websocket interrupt was rejected or mismatched")
        }
      }
      return true
    },
    complete() {
      terminal = true
    },
    dispose() {
      clearTimeout(deadlineTimer)
      clientSignal.removeEventListener("abort", onClientAbort)
      wakeWaiter?.()
    },
  }
}
