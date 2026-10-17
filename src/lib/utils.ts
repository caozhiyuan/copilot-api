import type { Context } from "hono"

import { createHash, randomUUID } from "node:crypto"

import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const getUserIdJsonField = (
  userIdPayload: Record<string, unknown> | null,
  field: string,
): string | null => {
  const value = userIdPayload?.[field]
  return typeof value === "string" && value.length > 0 ? value : null
}

const parseJsonUserId = (userId: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(userId)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export const parseUserIdMetadata = (
  userId: string | undefined,
): { safetyIdentifier: string | null; sessionId: string | null } => {
  if (!userId || typeof userId !== "string") {
    return { safetyIdentifier: null, sessionId: null }
  }

  const legacySafetyIdentifier =
    userId.match(/user_([^_]+)_account/)?.[1] ?? null
  const legacySessionId = userId.match(/_session_(.+)$/)?.[1] ?? null

  const parsedUserId =
    legacySafetyIdentifier && legacySessionId ? null : parseJsonUserId(userId)

  const safetyIdentifier =
    legacySafetyIdentifier
    ?? getUserIdJsonField(parsedUserId, "device_id")
    ?? getUserIdJsonField(parsedUserId, "account_uuid")
  const sessionId =
    legacySessionId ?? getUserIdJsonField(parsedUserId, "session_id")

  return { safetyIdentifier, sessionId }
}

export const getPromptCacheKey = (
  payload: Pick<AnthropicMessagesPayload, "metadata">,
): string | null => {
  const { sessionId } = parseUserIdMetadata(payload.metadata?.user_id)
  const store = requestContext.getStore()
  const rootSessionId = store?.rootSessionId?.trim() || null
  const sessionAffinity = store?.sessionAffinity?.trim() || null
  return rootSessionId ?? sessionId ?? sessionAffinity
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

export const getRootSessionId = (
  anthropicPayload: AnthropicMessagesPayload,
  c: Context,
): string | undefined => {
  const userId = anthropicPayload.metadata?.user_id
  const sessionId =
    userId ?
      parseUserIdMetadata(userId).sessionId || undefined
    : (c.req.header("x-root-session-id") ?? c.req.header("x-session-id"))

  return sessionId ? getUUID(sessionId) : sessionId
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
