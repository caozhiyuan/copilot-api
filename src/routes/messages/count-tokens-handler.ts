import type { Context } from "hono"

import consola from "consola"

import { getAnthropicApiKey } from "~/lib/config"
import { getTokenCount } from "~/lib/tokenizer"

import { findEndpointModel } from "../../lib/models"
import { type AnthropicMessagesPayload } from "./anthropic-types"
import { translateToOpenAI } from "./non-stream-translation"

/**
 * Forwards token counting to Anthropic's real /v1/messages/count_tokens endpoint.
 * Returns the result on success, or null to fall through to estimation.
 */
async function countTokensViaAnthropic(
  c: Context,
  payload: AnthropicMessagesPayload,
): Promise<Response | null> {
  if (!payload.model.startsWith("claude")) return null

  const apiKey = getAnthropicApiKey()
  if (!apiKey) return null

  // Copilot uses dotted names (claude-opus-4.6) but Anthropic requires dashes (claude-opus-4-6)
  const model = payload.model.replaceAll(".", "-")

  const res = await fetch(
    "https://api.anthropic.com/v1/messages/count_tokens",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "token-counting-2024-11-01",
      },
      body: JSON.stringify({ ...payload, model }),
    },
  )

  if (!res.ok) {
    consola.warn(
      "Anthropic count_tokens failed:",
      res.status,
      await res.text().catch(() => ""),
      "- falling back to estimation",
    )
    return null
  }

  const result = (await res.json()) as { input_tokens: number }
  consola.info("Token count (Anthropic API):", result.input_tokens)
  return c.json(result)
}

/**
 * Handles token counting for Anthropic messages.
 *
 * When an Anthropic API key is available (via config or ANTHROPIC_API_KEY env var)
 * and the model is a Claude model, forwards to Anthropic's free /v1/messages/count_tokens
 * endpoint for accurate counts. Otherwise falls back to GPT tokenizer estimation.
 */
export async function handleCountTokens(c: Context) {
  try {
    const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

    // Try Anthropic's real endpoint first (Claude models only)
    const anthropicResult = await countTokensViaAnthropic(c, anthropicPayload)
    if (anthropicResult) return anthropicResult

    // Fallback: GPT tokenizer estimation (also used for non-Claude models)
    const anthropicBeta = c.req.header("anthropic-beta")

    const openAIPayload = translateToOpenAI(anthropicPayload)

    const selectedModel = findEndpointModel(anthropicPayload.model)
    anthropicPayload.model = selectedModel?.id ?? anthropicPayload.model

    if (!selectedModel) {
      consola.warn("Model not found, returning default token count")
      return c.json({
        input_tokens: 1,
      })
    }

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)

    if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
      let addToolSystemPromptCount = false
      if (anthropicBeta) {
        const toolsLength = anthropicPayload.tools.length
        addToolSystemPromptCount = !anthropicPayload.tools.some(
          (tool) =>
            tool.name.startsWith("mcp__")
            || (tool.name === "Skill" && toolsLength === 1),
        )
      }
      if (addToolSystemPromptCount) {
        if (anthropicPayload.model.startsWith("claude")) {
          // https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview#pricing
          tokenCount.input = tokenCount.input + 346
        } else if (anthropicPayload.model.startsWith("grok")) {
          tokenCount.input = tokenCount.input + 120
        }
      }
    }

    let finalTokenCount = tokenCount.input + tokenCount.output
    if (anthropicPayload.model.startsWith("claude")) {
      finalTokenCount = Math.round(finalTokenCount * 1.15)
    }

    consola.info("Token count:", finalTokenCount)

    return c.json({
      input_tokens: finalTokenCount,
    })
  } catch (error) {
    consola.error("Error counting tokens:", error)
    return c.json({
      input_tokens: 1,
    })
  }
}
