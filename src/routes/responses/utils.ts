import type {
  ResponseInputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import { isForceAgentEnabled } from "~/lib/config"

export const getResponsesRequestOptions = (
  payload: ResponsesPayload,
): { vision: boolean; initiator: "agent" | "user" } => {
  const vision = hasVisionInput(payload)
  const initiator = hasAgentInitiator(payload) ? "agent" : "user"

  return { vision, initiator }
}

export const hasAgentInitiator = (payload: ResponsesPayload): boolean => {
  const items = getPayloadItems(payload)

  if (isForceAgentEnabled()) {
    // forceAgent mode: check if ANY item has assistant role
    return items.some((item) => isAgentRole(item))
  }

  // Default mode: only check the last item
  const lastItem = items.at(-1)
  if (!lastItem) {
    return false
  }
  return isAgentRole(lastItem)
}

// Helper function: check if a single item has agent role
const isAgentRole = (item: ResponseInputItem): boolean => {
  if (!("role" in item) || !item.role) {
    return true // No role means agent (preserve original logic)
  }
  const role = typeof item.role === "string" ? item.role.toLowerCase() : ""
  return role === "assistant"
}

export const hasVisionInput = (payload: ResponsesPayload): boolean => {
  const values = getPayloadItems(payload)
  return values.some((item) => containsVisionContent(item))
}

const getPayloadItems = (
  payload: ResponsesPayload,
): Array<ResponseInputItem> => {
  const result: Array<ResponseInputItem> = []

  const { input } = payload

  if (Array.isArray(input)) {
    result.push(...input)
  }

  return result
}

const containsVisionContent = (value: unknown): boolean => {
  if (!value) return false

  if (Array.isArray(value)) {
    return value.some((entry) => containsVisionContent(entry))
  }

  if (typeof value !== "object") {
    return false
  }

  const record = value as Record<string, unknown>
  const type =
    typeof record.type === "string" ? record.type.toLowerCase() : undefined

  if (type === "input_image") {
    return true
  }

  if (Array.isArray(record.content)) {
    return record.content.some((entry) => containsVisionContent(entry))
  }

  return false
}
