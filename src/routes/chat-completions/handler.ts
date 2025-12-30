import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { accountsManager } from "~/lib/accounts-manager"
import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

const logger = createHandlerLogger("chat-completions-handler")

const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  logger.debug("Request payload:", JSON.stringify(payload).slice(-400))

  const selection = await accountsManager.selectAccountForRequest([
    {
      modelId: payload.model,
      endpoint: CHAT_COMPLETIONS_ENDPOINT,
    },
  ])

  if (!selection.ok) {
    if (selection.reason === "MODEL_NOT_SUPPORTED") {
      return c.json(
        {
          error: {
            message: `Model "${payload.model}" is not available for any configured account.`,
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

  const { account, reservation, selectedModel } = selection

  // Calculate and display token count
  try {
    const tokenCount = await getTokenCount(payload, selectedModel)
    logger.info("Current token count:", tokenCount)
  } catch (error) {
    logger.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel.capabilities.limits.max_output_tokens,
    }
    logger.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  try {
    const ctx = {
      githubToken: account.githubToken,
      copilotToken: account.copilotToken,
      accountType: account.accountType,
      vsCodeVersion: account.vsCodeVersion,
    }
    const response = await createChatCompletions(payload, ctx)

    if (isNonStreaming(response)) {
      logger.debug("Non-streaming response:", JSON.stringify(response))
      return c.json(response)
    }

    logger.debug("Streaming response")
    return streamSSE(c, async (stream) => {
      for await (const chunk of response) {
        logger.debug("Streaming chunk:", JSON.stringify(chunk))
        await stream.writeSSE(chunk as SSEMessage)
      }
    })
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

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
