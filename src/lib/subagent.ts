import type { Context } from "hono"

import type { RequestContext } from "./request-context"

export interface SubagentMarker {
  session_id: string
  agent_id: string
  agent_type: string
}

// Session metadata belongs to the request, never to a marker inherited in history.
export function getSubagentFromSession(
  c: Context,
  session: Pick<RequestContext, "rootSessionId" | "sessionAffinity">,
): SubagentMarker | null {
  const { rootSessionId, sessionAffinity } = session
  const claudeAgentId = c.req.header("x-claude-code-agent-id")?.trim()
  const hasSessionAffinity = Boolean(
    c.req.header("x-opencode-session-id")?.trim()
      || c.req.header("x-session-affinity")?.trim(),
  )
  const isSubagent =
    Boolean(claudeAgentId && rootSessionId)
    || Boolean(c.req.header("x-openai-subagent")?.trim() && sessionAffinity)
    || Boolean(
      hasSessionAffinity && rootSessionId && rootSessionId !== sessionAffinity,
    )
  const agentId = claudeAgentId || sessionAffinity
  const sessionId = rootSessionId || sessionAffinity
  if (isSubagent && agentId && sessionId) {
    return {
      session_id: sessionId,
      agent_id: agentId,
      agent_type: "subagent",
    }
  }
  return null
}
