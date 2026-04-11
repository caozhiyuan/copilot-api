import type { AnthropicMessagesPayload } from "./anthropic-types"

const subagentMarkerPrefix = "__SUBAGENT_MARKER__"
const REMINDER_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/g

export interface SubagentMarker {
  session_id: string
  agent_id: string
  agent_type: string
}

export type SubagentMarkerInspection =
  | { kind: "none"; marker: null }
  | { kind: "invalid"; marker: null }
  | { kind: "valid"; marker: SubagentMarker }

const NONE_INSPECTION: SubagentMarkerInspection = {
  kind: "none",
  marker: null,
}

const INVALID_INSPECTION: SubagentMarkerInspection = {
  kind: "invalid",
  marker: null,
}

const isSubagentMarker = (value: unknown): value is SubagentMarker => {
  if (!value || typeof value !== "object") {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.session_id === "string"
    && typeof candidate.agent_id === "string"
    && typeof candidate.agent_type === "string"
    && candidate.session_id.length > 0
    && candidate.agent_id.length > 0
    && candidate.agent_type.length > 0
  )
}

export const inspectSubagentMarkerFromFirstUser = (
  payload: AnthropicMessagesPayload,
): SubagentMarkerInspection => {
  const firstUserMessage = payload.messages.find(
    (msg) => msg.role === "user" && Array.isArray(msg.content),
  )
  if (!firstUserMessage || !Array.isArray(firstUserMessage.content)) {
    return NONE_INSPECTION
  }

  let sawInvalidMarker = false

  for (const block of firstUserMessage.content) {
    if (block.type !== "text") {
      continue
    }

    const inspection = inspectSubagentMarkerFromSystemReminder(block.text)
    if (inspection.kind === "valid") {
      return inspection
    }

    if (inspection.kind === "invalid") {
      sawInvalidMarker = true
    }
  }

  return sawInvalidMarker ? INVALID_INSPECTION : NONE_INSPECTION
}

export const parseSubagentMarkerFromFirstUser = (
  payload: AnthropicMessagesPayload,
): SubagentMarker | null => {
  const inspection = inspectSubagentMarkerFromFirstUser(payload)
  return inspection.kind === "valid" ? inspection.marker : null
}

const inspectSubagentMarkerFromSystemReminder = (
  text: string,
): SubagentMarkerInspection => {
  let sawInvalidMarker = false

  for (const [, content] of text.matchAll(REMINDER_RE)) {
    const markerIndex = content.indexOf(subagentMarkerPrefix)
    if (markerIndex === -1) continue

    const afterPrefix = content
      .slice(markerIndex + subagentMarkerPrefix.length)
      .trimStart()
    if (!afterPrefix.startsWith("{")) {
      sawInvalidMarker = true
      continue
    }

    const json = extractBalancedJson(afterPrefix)
    if (!json) {
      sawInvalidMarker = true
      continue
    }

    try {
      const parsed: unknown = JSON.parse(json)
      if (!isSubagentMarker(parsed)) {
        sawInvalidMarker = true
        continue
      }
      return {
        kind: "valid",
        marker: parsed,
      }
    } catch {
      sawInvalidMarker = true
    }
  }

  return sawInvalidMarker ? INVALID_INSPECTION : NONE_INSPECTION
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
