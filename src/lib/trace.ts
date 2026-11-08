import type { MiddlewareHandler } from "hono"

import {
  requestContext,
  resolveTraceId,
  type RequestContext,
} from "./request-context"
import { getSubagentFromSession } from "./subagent"
import {
  getRootSessionIdFromHeaders,
  getSessionAffinityFromHeaders,
} from "./utils"

export const traceIdMiddleware: MiddlewareHandler = async (c, next) => {
  const traceId = resolveTraceId(c.req.header("x-trace-id"))

  c.header("x-trace-id", traceId)

  const context: RequestContext = {
    traceId,
    startTime: Date.now(),
    userAgent: c.req.header("user-agent") || "",
    sessionAffinity: getSessionAffinityFromHeaders(c),
    rootSessionId: getRootSessionIdFromHeaders(c),
    parentSessionId: c.req.header("x-parent-session-id")?.trim() || undefined,
  }
  context.subagent = getSubagentFromSession(c, context)

  await requestContext.run(context, async () => {
    await next()
  })
}
