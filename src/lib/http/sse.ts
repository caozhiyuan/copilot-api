import type { SSEMessage, SSEStreamingApi } from "hono/streaming"

import { requestContext } from "./request-context"

const isProtocolFailure = (eventType: string | undefined): boolean =>
  eventType === "error" || eventType === "response.failed"

export async function writeSSEIfConnected(
  stream: SSEStreamingApi,
  message: SSEMessage,
  eventType = message.event,
): Promise<boolean> {
  if (stream.aborted) return false

  // Failure can be signalled by either the SSE event line or the JSON type.
  if (isProtocolFailure(eventType) || isProtocolFailure(message.event)) {
    const timing = requestContext.getStore()?.requestTiming
    if (timing) timing.protocolFailed = true
  }

  try {
    await stream.writeSSE(message)
    return true
  } catch (error) {
    if (stream.aborted) return false
    throw error
  }
}
