import type { Context } from "hono"

import consola from "consola"

import { resolveMappedModel } from "~/lib/config"
import { assertAllowedModel } from "~/lib/model-admission"
import { createFallbackModel } from "~/lib/provider-model"
import { resolveConfiguredProviderModelAlias } from "~/lib/provider-resolver"
import { getTokenCount } from "~/lib/tokenizer"
import { handleProviderCountTokensForProvider } from "~/routes/provider/messages/count-tokens-handler"
import { type Model } from "~/lib/types/models"

import { findEndpointModel } from "../../lib/models"
import { type AnthropicMessagesPayload } from "~/lib/types/anthropic"
import { translateToOpenAI } from "./non-stream-translation"
import { normalizeSystemMessages } from "./preprocess"

export const resolveCountTokensModel = (
  modelId: string,
  findModel: (sdkModelId: string) => Model | undefined = findEndpointModel,
): { fallback: boolean; model: Model } => {
  const selectedModel = findModel(modelId)
  if (selectedModel) {
    return {
      fallback: false,
      model: selectedModel,
    }
  }

  return {
    fallback: true,
    model: createFallbackModel(modelId.trim()),
  }
}

/** Handles token counting for Anthropic-compatible message requests. */
export async function handleCountTokens(c: Context) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  anthropicPayload.model = resolveMappedModel(anthropicPayload.model)
  assertAllowedModel(anthropicPayload.model)
  normalizeSystemMessages(anthropicPayload)

  const providerModelAlias = await resolveConfiguredProviderModelAlias(
    anthropicPayload.model,
  )
  if (providerModelAlias) {
    anthropicPayload.model = providerModelAlias.model
    return await handleProviderCountTokensForProvider(c, {
      payload: anthropicPayload,
      provider: providerModelAlias.provider,
    })
  }

  // Estimate with the tokenizer metadata exposed by the selected model.
  const openAIPayload = translateToOpenAI(anthropicPayload)

  const requestedModel = anthropicPayload.model
  const resolve = resolveCountTokensModel(requestedModel)

  const selectedModel = resolve.model
  anthropicPayload.model = selectedModel.id

  if (resolve.fallback) {
    consola.warn(
      `Model '${requestedModel}' not found, using o200k_base fallback tokenizer`,
    )
  }

  const tokenCount = await getTokenCount(openAIPayload, selectedModel)

  const finalTokenCount = tokenCount.input + tokenCount.output
  consola.info("Token count:", finalTokenCount)

  return c.json({
    input_tokens: finalTokenCount,
  })
}
