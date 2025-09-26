import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

const RESPONSES_ENDPOINT = "/responses"

export const handleResponses = async (c: Context) => {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  consola.debug(
    "Responses request payload:",
    JSON.stringify(payload).slice(-400),
  )

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  if (!supportsResponses) {
    return c.json(
      {
        error: {
          message:
            "This model does not support the responses endpoint. Please choose a different model.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  const vision = hasVisionInput(payload)
  const initiator = hasAgentInitiator(payload) ? "agent" : "user"

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createResponses(payload, { vision, initiator })

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    consola.debug("Forwarding native Responses stream")
    return streamSSE(c, async (stream) => {
      for await (const chunk of response) {
        consola.debug("Responses stream chunk:", JSON.stringify(chunk))
        await stream.writeSSE({
          id: (chunk as { id?: string }).id,
          event: (chunk as { event?: string }).event,
          data: (chunk as { data?: string }).data ?? "",
        })
      }
    })
  }

  consola.debug(
    "Forwarding native Responses result:",
    JSON.stringify(response).slice(-400),
  )
  return c.json(response as ResponsesResult)
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const hasAgentInitiator = (payload: ResponsesPayload): boolean =>
  getMessageItems(payload).some((item) => {
    const role = typeof item.role === "string" ? item.role.toLowerCase() : ""
    return role === "assistant" || role === "tool"
  })

const hasVisionInput = (payload: ResponsesPayload): boolean => {
  const values = getPayloadItems(payload)
  return values.some((item) => containsVisionContent(item))
}

type MessageCandidate = {
  role?: unknown
  content?: unknown
}

const getPayloadItems = (payload: ResponsesPayload): Array<unknown> => {
  const result: Array<unknown> = []

  const { input, instructions } = payload

  if (Array.isArray(input)) {
    result.push(...input)
  }

  if (Array.isArray(instructions)) {
    result.push(...instructions)
  }

  return result
}

const getMessageItems = (
  payload: ResponsesPayload,
): Array<MessageCandidate & { role: string }> => {
  return getPayloadItems(payload)
    .filter((item): item is MessageCandidate & { role: string } => {
      if (!item || typeof item !== "object") return false
      if (!("role" in item)) return false
      const role = (item as MessageCandidate & { role: unknown }).role
      return typeof role === "string"
    })
    .map((item) => item as MessageCandidate & { role: string })
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
