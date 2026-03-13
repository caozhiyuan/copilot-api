import type { Context } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { createHandlerLogger } from "~/lib/logger"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { type AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import { translateToOpenAI } from "~/routes/messages/non-stream-translation"

const logger = createHandlerLogger("provider-count-tokens-handler")

const createFallbackModel = (modelId: string): Model => ({
  capabilities: {
    family: "provider",
    limits: {},
    object: "model_capabilities",
    supports: {},
    tokenizer: "o200k_base",
    type: "chat",
  },
  id: modelId,
  model_picker_enabled: false,
  name: modelId,
  object: "model",
  preview: false,
  vendor: "provider",
  version: "unknown",
})

export async function handleProviderCountTokens(c: Context): Promise<Response> {
  const provider = c.req.param("provider")

  try {
    const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
    const openAIPayload = translateToOpenAI(anthropicPayload)
    const modelId = anthropicPayload.model.trim()

    let selectedModel = state.models?.data.find((model) => model.id === modelId)

    if (!selectedModel && modelId) {
      selectedModel = createFallbackModel(modelId)
    }

    if (!selectedModel) {
      logger.warn("provider.count_tokens.model_not_found", {
        provider,
        model: anthropicPayload.model,
      })
      return c.json({
        input_tokens: 1,
      })
    }

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)
    const finalTokenCount = tokenCount.input + tokenCount.output

    logger.debug("provider.count_tokens.success", {
      provider,
      model: anthropicPayload.model,
      input_tokens: finalTokenCount,
    })

    return c.json({
      input_tokens: finalTokenCount,
    })
  } catch (error) {
    logger.error("provider.count_tokens.error", {
      provider,
      error,
    })
    return c.json({
      input_tokens: 1,
    })
  }
}
