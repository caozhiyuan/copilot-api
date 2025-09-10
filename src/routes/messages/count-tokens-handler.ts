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
    if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
      if (anthropicPayload.model.startsWith("claude")) {
        // https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview#pricing
        tokenCount.input = tokenCount.input + 346
      } else if (anthropicPayload.model.startsWith("grok")) {
        tokenCount.input = tokenCount.input + 128
      }
    }

    // Calculate final token count with model-specific corrections
    let finalTokenCount = tokenCount.input + tokenCount.output

    // Apply correction factor for Claude models
    if (anthropicPayload.model.startsWith("claude")) {
      finalTokenCount = Math.round(finalTokenCount * 1.05)
    } else if (anthropicPayload.model.startsWith("grok")) {
      finalTokenCount = Math.round(finalTokenCount * 1.022)
    }

    consola.info("Token count:", finalTokenCount)

    // Return response in Anthropic API format
    return c.json({
      input_tokens: finalTokenCount,
    })
  } catch (error) {
    consola.error("Error counting tokens:", error)
    // Return default value on error
    return c.json({
      input_tokens: 1,
    })
  }
}
