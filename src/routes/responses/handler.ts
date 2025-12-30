import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { accountsManager } from "~/lib/accounts-manager"
import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

import { getResponsesRequestOptions } from "./utils"

const logger = createHandlerLogger("responses-handler")

const RESPONSES_ENDPOINT = "/responses"

export const handleResponses = async (c: Context) => {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  logger.debug("Responses request payload:", JSON.stringify(payload))

  const selection = await accountsManager.selectAccountForRequest([
    {
      modelId: payload.model,
      endpoint: RESPONSES_ENDPOINT,
    },
  ])

  if (!selection.ok) {
    if (selection.reason === "MODEL_NOT_SUPPORTED") {
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

    return c.json(
      {
        error: {
          message:
            "All accounts have exhausted their quota. Please wait for quota refresh or add additional accounts.",
          type: "rate_limit_error",
        },
      },
      429,
    )
  }

  const { account, reservation } = selection

  const { vision, initiator } = getResponsesRequestOptions(payload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  try {
    const ctx = {
      githubToken: account.githubToken,
      copilotToken: account.copilotToken,
      accountType: account.accountType,
      vsCodeVersion: account.vsCodeVersion,
    }
    const response = await createResponses(payload, { vision, initiator }, ctx)

    if (isStreamingRequested(payload) && isAsyncIterable(response)) {
      logger.debug("Forwarding native Responses stream")
      return streamSSE(c, async (stream) => {
        for await (const chunk of response) {
          logger.debug("Responses stream chunk:", JSON.stringify(chunk))
          await stream.writeSSE({
            id: (chunk as { id?: string }).id,
            event: (chunk as { event?: string }).event,
            data: (chunk as { data?: string }).data ?? "",
          })
        }
      })
    }

    logger.debug(
      "Forwarding native Responses result:",
      JSON.stringify(response).slice(-400),
    )
    return c.json(response as ResponsesResult)
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 401) {
      accountsManager.markAccountFailed(account.id, "Unauthorized (401)")
    }
    throw error
  } finally {
    // Refresh quota after request completes
    await accountsManager.finalizeQuota(account, reservation)
  }
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)
