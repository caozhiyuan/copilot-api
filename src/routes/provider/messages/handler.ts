import type { Context, Env } from "hono"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/types/anthropic"

import { getClaudeAutoModel, resolveProviderConfigForModel } from "~/lib/config"
import { fromClaudeDiscoveryModelId } from "~/lib/claude-models"

import { HTTPError } from "~/lib/error"

import { debugJson } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { type TokenUsageEndpoint } from "~/lib/token-usage"
import { setPluginRequestModel } from "~/lib/request-events"

import {
  hasWebSearchServerTool,
  isWebSearchOnlyRequest,
  stripWebSearchServerTool,
} from "~/routes/messages/web-search/fulfill"
import {
  appendClaudeContinuationMessage,
  applyClaudeNoToolsEffort,
  isClaudeAutoModelRequest,
  normalizeSystemMessages,
} from "~/routes/messages/preprocess"

import { forwardProviderMessages } from "~/services/providers/provider-proxy"
import {
  applyMissingExtraBody,
  applyModelDefaults,
} from "~/routes/provider/utils"
import consola from "consola"
import { handleGoogleProviderMessages } from "./google-handler"
import {
  respondProviderMessagesJson,
  streamProviderMessages,
} from "./handlers/anthropic"
import { logger } from "./handlers/log"
import { handleOpenAICompatibleProviderMessages } from "./handlers/openai-compatible"
import {
  handleOpenAIResponsesProviderMessages,
  handleOpenAIResponsesProviderWebSearchMessages,
} from "./handlers/openai-responses"

export const providerMessagesHandlerDependencies = {
  resolveProviderConfig,
}

export async function handleProviderMessages(
  c: Context<Env, "/:provider">,
): Promise<Response> {
  const provider = c.req.param("provider")
  const payload = await c.req.json<AnthropicMessagesPayload>()
  setPluginRequestModel(payload.model)
  payload.model = fromClaudeDiscoveryModelId(payload.model)
  applyClaudeNoToolsEffort(payload, c.req.header("user-agent"))

  const claudeAutoModel = getClaudeAutoModel()
  if (claudeAutoModel && isClaudeAutoModelRequest(payload)) {
    consola.debug(
      `Claude auto model override (${provider}): ${payload.model} -> ${claudeAutoModel}`,
    )
    payload.model = claudeAutoModel
  }

  return await handleProviderMessagesForProvider(c, {
    payload,
    provider,
  })
}

export async function handleProviderMessagesForProvider(
  c: Context,
  options: {
    payload: AnthropicMessagesPayload
    provider: string
    usageEndpoint?: TokenUsageEndpoint
  },
): Promise<Response> {
  const { payload, provider, usageEndpoint } = options
  const configuredProvider =
    await providerMessagesHandlerDependencies.resolveProviderConfig(provider)
  if (!configuredProvider) {
    return c.json(
      {
        error: {
          message: `Provider '${provider}' not found or disabled`,
          type: "invalid_request_error",
        },
      },
      404,
    )
  }

  try {
    const providerConfig = resolveProviderConfigForModel(
      configuredProvider,
      payload.model,
    )
    const modelConfig = providerConfig.models?.[payload.model]
    const effectiveType = providerConfig.type
    debugJson(logger, "provider.messages.request", { payload, provider })

    normalizeSystemMessages(payload)

    applyModelDefaults(payload, modelConfig)
    appendClaudeContinuationMessage(payload)

    if (effectiveType === "google") {
      stripWebSearchServerTool(payload)
      return await handleGoogleProviderMessages(
        c,
        payload,
        providerConfig,
        usageEndpoint,
      )
    }

    if (effectiveType === "openai-responses") {
      if (hasWebSearchServerTool(payload)) {
        if (isWebSearchOnlyRequest(payload)) {
          return await handleOpenAIResponsesProviderWebSearchMessages(c, {
            modelConfig,
            payload,
            provider,
            providerConfig,
            usageEndpoint,
          })
        }

        stripWebSearchServerTool(payload)
      }

      return await handleOpenAIResponsesProviderMessages(c, {
        modelConfig,
        payload,
        provider,
        providerConfig,
        usageEndpoint,
      })
    }

    if (effectiveType === "openai-compatible") {
      stripWebSearchServerTool(payload)

      return await handleOpenAICompatibleProviderMessages(c, {
        modelConfig,
        payload,
        provider,
        providerConfig,
        usageEndpoint,
      })
    }

    applyMissingExtraBody(payload as unknown as Record<string, unknown>, {
      extraBody: modelConfig?.extraBody,
    })

    debugJson(logger, "Translated provider.messages.request", {
      payload,
      provider,
    })
    const upstreamResponse = await forwardProviderMessages(
      providerConfig,
      payload,
      c.req.raw.headers,
      { clientSignal: c.req.raw.signal },
    )

    if (!upstreamResponse.ok) {
      logger.error("Failed to create responses", upstreamResponse)
      throw new HTTPError("Failed to create responses", upstreamResponse)
    }

    const contentType = upstreamResponse.headers.get("content-type") ?? ""
    const isStreamingResponse =
      Boolean(payload.stream) && contentType.includes("text/event-stream")

    if (isStreamingResponse) {
      return streamProviderMessages({
        c,
        modelConfig,
        payload,
        pricingCurrency: providerConfig.pricingCurrency,
        provider,
        upstreamResponse,
        usageEndpoint,
      })
    }

    const jsonBody = (await upstreamResponse.json()) as AnthropicResponse
    return respondProviderMessagesJson(c, {
      body: jsonBody,
      modelConfig,
      payload,
      pricingCurrency: providerConfig.pricingCurrency,
      provider,
      usageEndpoint,
    })
  } catch (error) {
    logger.error("provider.messages.error", {
      provider,
      error,
    })
    throw error
  }
}
