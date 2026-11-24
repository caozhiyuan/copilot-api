export interface SubagentMarker {
  session_id: string
  agent_id: string
  agent_type: string
}

export function resolveSubagentMarker(
  rootSessionId: string | undefined,
  sessionAffinity: string | undefined,
): SubagentMarker | null {
  return rootSessionId && sessionAffinity && rootSessionId !== sessionAffinity ?
      {
        session_id: rootSessionId,
        agent_id: sessionAffinity,
        agent_type: "subagent",
      }
    : null
}
