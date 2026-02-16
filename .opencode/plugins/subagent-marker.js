const MARKER_PREFIX = "__SUBAGENT_MARKER__"

const subagentSessions = new Set()
const markedSessions = new Set()

const getSessionInfo = (event) => {
  if (!event || typeof event !== "object") return undefined
  const properties = event.properties
  if (!properties || typeof properties !== "object") return undefined
  const info = properties.info
  if (!info || typeof info !== "object") return undefined
  return info
}

export const SubagentMarkerPlugin = async () => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const info = getSessionInfo(event)
        if (info?.id && info.parentID) {
          subagentSessions.add(info.id)
        }
        return
      }

      if (event.type === "session.deleted") {
        const info = getSessionInfo(event)
        if (info?.id) {
          subagentSessions.delete(info.id)
          markedSessions.delete(info.id)
        }
      }
    },
    "chat.message": async (input, output) => {
      const { sessionID } = input
      if (!subagentSessions.has(sessionID) || markedSessions.has(sessionID)) {
        return
      }
      if (!output.message?.id || !output.message?.sessionID) {
        return
      }

      const marker = `${MARKER_PREFIX}${JSON.stringify({
        session_id: sessionID,
        agent_id: sessionID,
        agent_type: input.agent ?? "opencode-subagent",
      })}`

      output.parts.unshift({
        id: `${output.message.id}-subagent-marker`,
        sessionID: output.message.sessionID,
        messageID: output.message.id,
        type: "text",
        text: `<system-reminder>\nSubagentStart hook additional context: ${marker}\n</system-reminder>`,
        synthetic: true,
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })

      markedSessions.add(sessionID)
    },
  }
}
