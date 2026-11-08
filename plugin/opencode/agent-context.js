const MARKER_PREFIX = "__SUBAGENT_MARKER__"

const createSessionLookup = (loadSession) => {
  const sessions = new Map()

  const getSession = async (sessionID) => {
    const cached = sessions.get(sessionID)
    if (cached) return cached

    try {
      const info = await loadSession(sessionID)
      if (info?.id !== sessionID) return undefined
      sessions.set(sessionID, info)
      return info
    } catch {
      return undefined
    }
  }

  const getRootSessionID = async (sessionID) => {
    const visited = new Set()
    let currentID = sessionID

    while (!visited.has(currentID)) {
      visited.add(currentID)
      const info = await getSession(currentID)
      if (!info) return undefined
      if (!info.parentID) return info.id
      currentID = info.parentID
    }

    return undefined
  }

  return { sessions, getSession, getRootSessionID }
}

const setRootSessionHeader = (headers, sessionID) => {
  // Remove every casing of the root header so Fetch does not combine values.
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "x-root-session-id") delete headers[name]
  }
  headers["x-root-session-id"] = sessionID
}

const getSessionInfo = (event) => {
  if (!event || typeof event !== "object") return undefined
  const properties = event.properties
  if (!properties || typeof properties !== "object") return undefined
  const info = properties.info
  if (!info || typeof info !== "object") return undefined
  return info
}

export const AgentContextPlugin = async ({ client } = {}) => {
  const markedSessions = new Set()
  const lookup = createSessionLookup(async (sessionID) => {
    const result = await client?.session.get({ path: { id: sessionID } })
    return result?.data
  })

  return {
    event: async ({ event }) => {
      const info = getSessionInfo(event)
      if (!info?.id) return

      if (event.type === "session.created") {
        lookup.sessions.set(info.id, info)
      } else if (event.type === "session.deleted") {
        markedSessions.delete(info.id)
        lookup.sessions.delete(info.id)
      }
    },
    "chat.message": async (input, output) => {
      const { sessionID } = input
      if (markedSessions.has(sessionID)) return
      if (!output.message?.id || !output.message?.sessionID) {
        return
      }
      const info = await lookup.getSession(sessionID)
      if (!info?.parentID || markedSessions.has(sessionID)) return

      const marker = `${MARKER_PREFIX}${JSON.stringify({
        session_id: sessionID,
        agent_id: sessionID,
        agent_type: input.agent ?? "opencode-subagent",
      })}`

      output.parts.unshift({
        id: `prt-${output.message.id}-subagent-marker`,
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
    "chat.headers": async (input, output) => {
      const { sessionID } = input
      const rootSessionID = await lookup.getRootSessionID(sessionID)
      if (rootSessionID) setRootSessionHeader(output.headers, rootSessionID)
    },
  }
}

// v1 uses server(); v2 uses setup(). Both entrypoints share root traversal.
export default {
  id: "copilot-api.agent-context",
  server: AgentContextPlugin,
  setup: async (context) => {
    await context.session.hook("model.request", async (input) => {
      // Read the current ancestry for each request, including restored sessions.
      // v2 already supplies x-parent-session-id, so no marker injection is needed.
      const lookup = createSessionLookup(async (sessionID) => {
        const result = await context.session.get({ sessionID })
        // The v2 Promise API returns Session.Info directly, unlike the v1 SDK.
        // Also accept SDK-style data wrappers.
        return result?.data ?? result
      })
      const rootSessionID = await lookup.getRootSessionID(input.sessionID)
      if (rootSessionID) setRootSessionHeader(input.headers, rootSessionID)
    })
  },
}
