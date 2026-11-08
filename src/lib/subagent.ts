import type { Context } from "hono"

import type { RequestContext } from "./request-context"

export interface SubagentMarker {
  session_id: string
  agent_id: string
  agent_type: string
}

const codexSubagentTypes = new Set([
  "collab_spawn",
  "compact",
  "memory_consolidation",
  "review",
])

// Session metadata belongs to the request, never to a marker inherited in history.
export function getSubagentFromSession(
  c: Context,
  session: Pick<
    RequestContext,
    "rootSessionId" | "sessionAffinity" | "parentSessionId"
  >,
): SubagentMarker | null {
  const { rootSessionId, sessionAffinity, parentSessionId } = session
  const claudeAgentId = c.req.header("x-claude-code-agent-id")?.trim()
  if (claudeAgentId && rootSessionId) {
    return {
      session_id: rootSessionId,
      agent_id: claudeAgentId,
      agent_type:
        c.req.header("x-claude-code-agent-type")?.trim() || "claude-subagent",
    }
  }

  const codexAgentType = c.req.header("x-openai-subagent")?.trim()
  if (
    codexAgentType
    && codexSubagentTypes.has(codexAgentType)
    && sessionAffinity
  ) {
    return {
      session_id: rootSessionId ?? sessionAffinity,
      agent_id: sessionAffinity,
      agent_type: codexAgentType,
    }
  }

  const isOpencode =
    /opencode/iu.test(c.req.header("user-agent") ?? "")
    || Boolean(c.req.header("x-opencode-session-id")?.trim())
    || Boolean(parentSessionId && c.req.header("x-session-id")?.trim())
  if (
    isOpencode
    && sessionAffinity
    && ((parentSessionId && parentSessionId !== sessionAffinity)
      || (rootSessionId && rootSessionId !== sessionAffinity))
  ) {
    return {
      session_id: rootSessionId ?? parentSessionId ?? sessionAffinity,
      agent_id: sessionAffinity,
      agent_type: "opencode-subagent",
    }
  }
  return null
}
