import type { Context } from "hono"

import { createHash, randomUUID } from "node:crypto"

import type { ResponsesStream } from "~/lib/types/responses"

import { state } from "./state"
import { requestContext } from "./request-context"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

export const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

export const isResponsesStream = (value: unknown): value is ResponsesStream =>
  isAsyncIterable<unknown>(value)

interface PayloadMessage {
  role?: string
  content?: string | Array<{ type?: string; text?: string }> | null
  type?: string
}

export const getPromptCacheKey = (): string | null => {
  const store = requestContext.getStore()
  const rootSessionId = store?.rootSessionId?.trim() || null
  const sessionAffinity = store?.sessionAffinity?.trim() || null
  return rootSessionId ?? sessionAffinity
}

const findLastUserContent = (
  messages: Array<PayloadMessage>,
): string | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user" && msg.content) {
      if (typeof msg.content === "string") {
        return msg.content
      } else if (Array.isArray(msg.content)) {
        const array = msg.content
          .filter((n) => n.type !== "tool_result")
          .map((n) => ({ ...n, cache_control: undefined }))
        if (array.length > 0) {
          return JSON.stringify(array)
        }
      }
    }
  }
  return null
}

export const generateRequestIdFromPayload = (
  payload: {
    messages: string | Array<PayloadMessage> | undefined
  },
  sessionId?: string,
): string => {
  const messages = payload.messages
  if (messages) {
    const lastUserContent =
      typeof messages === "string" ? messages : findLastUserContent(messages)

    if (lastUserContent) {
      return getUUID(
        (sessionId ?? "") + (state.macMachineId ?? "") + lastUserContent,
      )
    }
  }

  return randomUUID()
}

// Claude's session ID groups its main agent and all spawned agents. Codex uses
// session-id; the OpenCode agent-context plugin supplies x-root-session-id.
export const getRootSessionIdFromHeaders = (c: Context): string | undefined =>
  c.req.header("x-claude-code-session-id")?.trim()
  || c.req.header("session-id")?.trim()
  || c.req.header("x-root-session-id")?.trim()
  || c.req.header("x-session-id")?.trim()
  || undefined

// Shared by the request context and the Responses route. The codex thread id
// counts as a client request id, so it is accepted as the last resort.
export const getSessionAffinityFromHeaders = (
  c: Context,
): string | undefined => {
  const claudeSessionId = c.req.header("x-claude-code-session-id")?.trim()
  if (claudeSessionId) {
    const agentId = c.req.header("x-claude-code-agent-id")?.trim()
    return agentId ? `${claudeSessionId}:${agentId}` : claudeSessionId
  }
  return (
    c.req.header("x-opencode-session-id")?.trim()
    || c.req.header("x-session-affinity")?.trim()
    || c.req.header("x-client-request-id")?.trim()
    || c.req.header("thread-id")?.trim()
    || undefined
  )
}

// Upstream interaction IDs use the trace session, hashed to a UUID.
export const getRootSessionId = (): string | undefined => {
  const sessionId = getPromptCacheKey()
  return sessionId ? getUUID(sessionId) : undefined
}

export const getUUID = (content: string): string => {
  const uuidBytes = createHash("sha256")
    .update(content)
    .digest()
    .subarray(0, 16)

  uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x40
  uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80

  const uuidHex = uuidBytes.toString("hex")

  return `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20)}`
}
