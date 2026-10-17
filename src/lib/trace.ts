import type { MiddlewareHandler } from "hono"

import { requestContext, resolveTraceId } from "./request-context"

export const traceIdMiddleware: MiddlewareHandler = async (c, next) => {
  const traceId = resolveTraceId(c.req.header("x-trace-id"))

  c.header("x-trace-id", traceId)

  const context = {
    traceId,
    startTime: Date.now(),
    userAgent: c.req.header("user-agent") || "",
    sessionAffinity:
      c.req.header("x-opencode-session-id")
      ?? c.req.header("x-session-affinity")
      ?? c.req.header("x-client-request-id"),
    rootSessionId:
      c.req.header("session-id")?.trim()
      || c.req.header("x-root-session-id")?.trim()
      || c.req.header("x-session-id")?.trim(),
    parentSessionId: c.req.header("x-parent-session-id"),
  }

  await requestContext.run(context, async () => {
    await next()
  })
}
