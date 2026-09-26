import type { Context } from "hono"

import { builtinProviderModelRegistry } from "~/lib/builtin-provider-models"
import type { ModelConfig, ResolvedProviderConfig } from "~/lib/config"
import {
  resolveSupportedReasoningEffort,
  type ResponsesReasoningEffort,
} from "~/lib/reasoning-effort"
import type { ResponsesPayload } from "~/lib/types/responses"
import { createProviderProxyResponseHeaders } from "~/services/providers/provider-proxy"

export const forwardProviderResponseHeaders = (
  c: Context,
  upstreamHeaders: Headers,
): void => {
  const headers = createProviderProxyResponseHeaders(upstreamHeaders)
  headers.delete("set-cookie")
  headers.delete("x-models-etag")

  for (const [headerName, headerValue] of headers) {
    c.header(headerName, headerValue)
  }
}

interface SamplingPayload {
  temperature?: number | null
  top_p?: number | null
  top_k?: number | null
}

export const applyModelDefaults = (
  payload: SamplingPayload,
  modelConfig: ModelConfig | undefined,
): void => {
  payload.temperature ??= modelConfig?.temperature
  payload.top_p ??= modelConfig?.topP
  payload.top_k ??= modelConfig?.topK
}

export const applyMissingExtraBody = (
  payload: Record<string, unknown>,
  options: { extraBody: Record<string, unknown> | undefined },
): void => {
  for (const [key, value] of Object.entries(options.extraBody ?? {})) {
    if (!Object.hasOwn(payload, key)) {
      payload[key] = value
    }
  }
}

export const normalizeProviderResponsesReasoningEffort = (
  payload: ResponsesPayload,
  providerConfig: ResolvedProviderConfig,
): { from: string; to: ResponsesReasoningEffort } | undefined => {
  if (!payload.reasoning || typeof payload.reasoning.effort !== "string") {
    return undefined
  }

  const modelConfig = providerConfig.models?.[payload.model]
  const builtinModelConfig = builtinProviderModelRegistry.getModelConfig(
    providerConfig.name,
    payload.model,
  )
  const configuredEfforts = modelConfig?.reasoningEfforts
  const supportedEfforts =
    configuredEfforts && configuredEfforts.length > 0 ?
      configuredEfforts
    : builtinModelConfig?.reasoningEfforts

  const resolvedEffort = resolveSupportedReasoningEffort(
    payload.reasoning.effort,
    supportedEfforts,
  )
  if (!resolvedEffort || resolvedEffort === payload.reasoning.effort) {
    return undefined
  }

  const requestedEffort = payload.reasoning.effort
  payload.reasoning.effort = resolvedEffort
  return { from: requestedEffort, to: resolvedEffort }
}
