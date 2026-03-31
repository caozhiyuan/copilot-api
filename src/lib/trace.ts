import type { MiddlewareHandler } from "hono"

import { requestContext, resolveTraceId } from "./request-context"

export const traceIdMiddleware: MiddlewareHandler = async (c, next) => {
  const traceId = resolveTraceId(c.req.header("x-trace-id"))

  c.header("x-trace-id", traceId)

  const context = {
    traceId,
    startTime: Date.now(),
    userAgent: c.req.header("user-agent") || "",
  }

  await requestContext.run(context, async () => {
    await next()
  })
}
