import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import {
  createResponses,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-responses"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug(
    "Responses request payload:",
    JSON.stringify(payload).slice(-400),
  )

  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
  consola.info("Current token count:", getTokenCount(payload.messages))

  if (state.manualApprove) await awaitApproval()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (isNullish(payload.max_tokens)) {
    const selectedModel = state.models?.data.find(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (model) => model.id === payload.model,
    )

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const response = await createResponses(payload)

  if (isNonStreaming(response)) {
    consola.debug("Non-streaming responses response:", JSON.stringify(response))
    return c.json(response)
  }

  consola.debug("Streaming responses response")
  return streamSSE(c, async (stream) => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    for await (const chunk of response) {
      consola.debug("Responses streaming chunk:", JSON.stringify(chunk))
      await stream.writeSSE(chunk as SSEMessage)
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createResponses>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
