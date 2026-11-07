import type { SSEMessage, SSEStreamingApi } from "hono/streaming"

import { requestContext } from "./request-context"

export async function writeSSEIfConnected(
  stream: SSEStreamingApi,
  message: SSEMessage,
  eventType = message.event,
): Promise<boolean> {
  if (stream.aborted) return false

  if (eventType === "error" || eventType === "response.failed") {
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
