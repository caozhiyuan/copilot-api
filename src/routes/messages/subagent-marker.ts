import type { AnthropicMessagesPayload } from "./anthropic-types"

const subagentMarkerPrefix = "__SUBAGENT_MARKER__"
const REMINDER_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/g

export interface SubagentMarker {
  session_id: string
  agent_id: string
  agent_type: string
}

export const parseSubagentMarkerFromFirstUser = (
  payload: AnthropicMessagesPayload,
): SubagentMarker | null => {
  const firstUserMessage = payload.messages.find(
    (msg) => msg.role === "user" && Array.isArray(msg.content),
  )
  if (!firstUserMessage || !Array.isArray(firstUserMessage.content)) {
    return null
  }

  for (const block of firstUserMessage.content) {
    if (block.type !== "text") {
      continue
    }

    const marker = parseSubagentMarkerFromSystemReminder(block.text)
    if (marker) {
      return marker
    }
  }

  return null
}

const parseSubagentMarkerFromSystemReminder = (
  text: string,
): SubagentMarker | null => {
  for (const [, content] of text.matchAll(REMINDER_RE)) {
    const markerIndex = content.indexOf(subagentMarkerPrefix)
    if (markerIndex === -1) continue

    const afterPrefix = content
      .slice(markerIndex + subagentMarkerPrefix.length)
      .trimStart()
    if (!afterPrefix.startsWith("{")) continue

    const json = extractBalancedJson(afterPrefix)
    if (!json) continue

    try {
      const parsed = JSON.parse(json) as SubagentMarker
      if (!parsed.session_id || !parsed.agent_id || !parsed.agent_type) {
        continue
      }
      return parsed
    } catch {
      continue
    }
  }

  return null
}

/** Extract the first balanced `{...}` object from text that starts with `{`. */
const extractBalancedJson = (text: string): string | null => {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }

      if (char === "\\") {
        escaped = true
        continue
      }

      if (char === '"') {
        inString = false
      }

      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === "{") {
      depth += 1
      continue
    }

    if (char === "}") {
      depth -= 1
      if (depth === 0) return text.slice(0, index + 1)
    }
  }

  return null
}
