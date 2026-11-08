import type { MiddlewareHandler } from "hono"

import {
  requestContext,
  resolveTraceId,
  type RequestContext,
} from "./request-context"
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
    isClaudeCode: Boolean(c.req.header("x-claude-code-session-id")?.trim()),
    parentSessionId: c.req.header("x-parent-session-id"),
  }
  const { rootSessionId, sessionAffinity } = context
  const isSubagent = Boolean(
    c.req.header("x-openai-subagent")?.trim()
      || (rootSessionId
        && rootSessionId !== sessionAffinity
        && (context.isClaudeCode
          || c.req.header("x-opencode-session-id")?.trim()
          || c.req.header("x-session-affinity")?.trim())),
  )
  context.subagent =
    isSubagent && sessionAffinity ?
      {
        session_id: rootSessionId ?? sessionAffinity,
        agent_id:
          c.req.header("x-claude-code-agent-id")?.trim() || sessionAffinity,
        agent_type: "subagent",
      }
    : null

  await requestContext.run(context, async () => {
    await next()
  })
}
