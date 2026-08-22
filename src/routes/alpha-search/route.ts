import { Hono, type Context } from "hono"
import consola from "consola"

import {
  getAlphaSearchModel,
  isAlphaSearchCodexPriorityEnabled,
  resolveEffectiveProviderType,
  resolveMappedModel,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger, debugJsonAsync } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import type {
  AlphaSearchRequest,
  AlphaSearchResponse,
} from "~/routes/alpha-search/alpha-search-types"
import { handleAlphaSearchResponses } from "~/routes/alpha-search/alpha-search-responses"
import { forwardCodexAlphaSearch } from "~/services/codex/alpha-search"
import { createProviderProxyResponse } from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("alpha-search-handler")

export const alphaSearchRoutes = new Hono()

export const alphaSearchRouteDependencies = {
  findEndpointModel,
  forwardCodexAlphaSearch,
  getAlphaSearchModel,
  handleAlphaSearchResponses,
  isAlphaSearchCodexPriorityEnabled,
  resolveEffectiveProviderType,
  resolveMappedModel,
  resolveProviderConfig,
}

function parseDebugBody<T>(body: string): T | string {
  try {
    return JSON.parse(body) as T
  } catch {
    return body
  }
}

async function forwardCodexAlphaSearchRequest(
  request: Request,
): Promise<Response> {
  await debugJsonAsync(logger, "alpha_search.codex.request", async () => ({
    body: parseDebugBody<AlphaSearchRequest>(await request.clone().text()),
  }))

  const upstreamResponse =
    await alphaSearchRouteDependencies.forwardCodexAlphaSearch(request)
  await debugJsonAsync(logger, "alpha_search.codex.response", async () => ({
    body: parseDebugBody<AlphaSearchResponse>(
      await upstreamResponse.clone().text(),
    ),
    statusCode: upstreamResponse.status,
  }))
  return createProviderProxyResponse(upstreamResponse)
}

function createAlphaSearchRequest(
  request: Request,
  payload: AlphaSearchRequest,
): Request {
  // Rebuild from primitives instead of cloning: under Node runtimes srvx
  // wraps incoming requests in a proxy class whose prototype chain satisfies
  // `instanceof Request` without the native internals, so `new Request(req)`
  // throws "Cannot read properties of undefined (reading 'window')".
  return new Request(request.url, {
    body: JSON.stringify(payload),
    headers: request.headers,
    method: request.method,
    signal: request.signal,
  })
}

async function handleCodexRequest(
  c: Context,
  request: Request,
  resolvedProviderConfig?: ResolvedProviderConfig,
): Promise<Response> {
  const codexProviderConfig =
    resolvedProviderConfig
    ?? (await alphaSearchRouteDependencies.resolveProviderConfig("codex"))
  if (!codexProviderConfig) {
    return c.json(
      {
        error: {
          message: "Provider 'codex' not found or disabled",
          type: "invalid_request_error",
        },
      },
      404,
    )
  }

  return await forwardCodexAlphaSearchRequest(request)
}

function invalidRequest(c: Context, message: string): Response {
  return c.json(
    {
      error: {
        message,
        type: "invalid_request_error",
      },
    },
    400,
  )
}

async function parseAlphaSearchBody(
  c: Context,
): Promise<AlphaSearchRequest | Response> {
  let body: unknown
  try {
    body = await c.req.raw.clone().json()
  } catch {
    return invalidRequest(c, "Invalid alpha search request: expected JSON body")
  }

  const model = (body as AlphaSearchRequest | null)?.model
  if (typeof model !== "string") {
    return invalidRequest(
      c,
      "Invalid alpha search request: model must be a string",
    )
  }
  return body as AlphaSearchRequest
}

/**
 * Handles top-level alpha-search dispatch. Pass `resolvedProviderConfig` when
 * the provider-scoped route has already resolved Codex. Codex is preferred
 * for every top-level request while alphaSearchCodexPriority stays enabled.
 */
export async function handleAlphaSearchRequest(
  c: Context,
  resolvedProviderConfig?: ResolvedProviderConfig,
): Promise<Response> {
  if (resolvedProviderConfig) {
    return await handleCodexRequest(c, c.req.raw, resolvedProviderConfig)
  }

  const payload = await parseAlphaSearchBody(c)
  if (payload instanceof Response) return payload

  const requestedModel = payload.model

  payload.model =
    alphaSearchRouteDependencies.resolveMappedModel(requestedModel)
  if (payload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }

  const resolvedRequestedModel = payload.model
  let providerModelAlias = parseProviderModelAlias(payload.model)
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    if (providerModelAlias.provider === "codex") {
      return await handleCodexRequest(
        c,
        createAlphaSearchRequest(c.req.raw, payload),
      )
    }
  }

  if (alphaSearchRouteDependencies.isAlphaSearchCodexPriorityEnabled()) {
    const codexProviderConfig =
      await alphaSearchRouteDependencies.resolveProviderConfig("codex")
    if (codexProviderConfig) {
      if (!payload.model.startsWith("gpt")) {
        payload.model = "gpt-5.6-luna"
      }
      return await forwardCodexAlphaSearchRequest(
        createAlphaSearchRequest(c.req.raw, payload),
      )
    }
  }

  const messagesBackedModel = await isMessagesBackedModel(
    resolvedRequestedModel,
  )
  if (messagesBackedModel) {
    const searchModel = alphaSearchRouteDependencies.getAlphaSearchModel()
    if (!searchModel) {
      return invalidRequest(
        c,
        "alphaSearchModel is disabled; Messages-backed Codex models require a native Responses search model",
      )
    }
    const resolvedSearchModel =
      alphaSearchRouteDependencies.resolveMappedModel(searchModel)
    if (!(await isNativeResponsesModel(resolvedSearchModel))) {
      return invalidRequest(
        c,
        `Configured alphaSearchModel '${searchModel}' does not support the Responses endpoint required for alpha search`,
      )
    }
    consola.debug(
      `Redirected alpha search model: ${resolvedRequestedModel} -> ${resolvedSearchModel}`,
    )
    payload.model = resolvedSearchModel
    providerModelAlias = parseProviderModelAlias(payload.model)
    if (providerModelAlias) {
      payload.model = providerModelAlias.model
      if (providerModelAlias.provider === "codex") {
        return await handleCodexRequest(
          c,
          createAlphaSearchRequest(c.req.raw, payload),
        )
      }
    }
  }
  const fallbackRequestedModel =
    messagesBackedModel ? payload.model : requestedModel

  if (providerModelAlias) {
    // Only treat the "/" prefix as a custom provider alias when that provider
    // is actually configured. Namespaced model ids such as "org/family/model"
    // must fall through to the default alpha search path instead of being
    // passed to handleAlphaSearchResponses with an unconfigured provider and
    // surfaced as a 404.
    const providerConfig =
      await alphaSearchRouteDependencies.resolveProviderConfig(
        providerModelAlias.provider,
      )
    if (providerConfig) {
      return await alphaSearchRouteDependencies.handleAlphaSearchResponses(c, {
        provider: providerModelAlias.provider,
        request: payload,
      })
    }
  }

  return await alphaSearchRouteDependencies.handleAlphaSearchResponses(c, {
    request: {
      ...payload,
      model: fallbackRequestedModel,
    },
  })
}

async function isMessagesBackedModel(model: string): Promise<boolean> {
  const providerAlias = parseProviderModelAlias(model)
  if (providerAlias) {
    const providerConfig =
      await alphaSearchRouteDependencies.resolveProviderConfig(
        providerAlias.provider,
      )
    if (!providerConfig) return false
    const effectiveType =
      alphaSearchRouteDependencies.resolveEffectiveProviderType(
        providerConfig,
        providerAlias.model,
      )
    return (
      effectiveType === "anthropic" || effectiveType === "openai-compatible"
    )
  }

  const endpoints =
    alphaSearchRouteDependencies.findEndpointModel(model)?.supported_endpoints
    ?? []
  return (
    (endpoints.includes("/v1/messages")
      || endpoints.includes("/chat/completions"))
    && !endpoints.includes("/responses")
    && !endpoints.includes("ws:/responses")
  )
}

async function isNativeResponsesModel(model: string): Promise<boolean> {
  const providerAlias = parseProviderModelAlias(model)
  if (providerAlias) {
    const providerConfig =
      await alphaSearchRouteDependencies.resolveProviderConfig(
        providerAlias.provider,
      )
    return (
      providerConfig !== null
      && alphaSearchRouteDependencies.resolveEffectiveProviderType(
        providerConfig,
        providerAlias.model,
      ) === "openai-responses"
    )
  }

  const endpoints =
    alphaSearchRouteDependencies.findEndpointModel(model)?.supported_endpoints
    ?? []
  return endpoints.includes("/responses") || endpoints.includes("ws:/responses")
}

alphaSearchRoutes.post("/", async (c) => {
  try {
    return await handleAlphaSearchRequest(c)
  } catch (error) {
    logger.error("alpha_search.error", { error })
    return await forwardError(c, error)
  }
})
