import type { Context } from "hono"

import consola from "consola"

import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"

import { type AnthropicMessagesPayload } from "./anthropic-types"
import { translateToOpenAI } from "./non-stream-translation"

/**
 * Handles token counting for Anthropic messages
 */
export async function handleCountTokens(c: Context) {
  try {
    const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

    // Convert to OpenAI format for token counting
    const openAIPayload = translateToOpenAI(anthropicPayload)

    // Find the selected model
    const selectedModel = state.models?.data.find(
      (model) => model.id === anthropicPayload.model,
    )

    if (!selectedModel) {
      consola.warn("Model not found, returning default token count")
      return c.json({
        input_tokens: 1,
      })
    }

    // Calculate token count
    const tokenCount = await getTokenCount(openAIPayload, selectedModel)
    consola.debug("Token count:", tokenCount)

    // Return response in Anthropic API format
    return c.json({
      input_tokens: tokenCount.input,
    })
  } catch (error) {
    consola.error("Error counting tokens:", error)
    // Return default value on error
    return c.json({
      input_tokens: 1,
    })
  }
}
