import { Hono, type Context } from "hono"

import {
  isAlphaSearchResponsesFallbackEnabled,
  isResponsesApiWebSearchEnabled,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger, debugJsonAsync } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import type {
  AlphaSearchRequest,
  AlphaSearchResponse,
} from "~/routes/alpha-search/alpha-search-types"
import { handleCopilotAlphaSearch } from "~/routes/alpha-search/copilot-fallback"
import { forwardCodexAlphaSearch } from "~/services/codex/alpha-search"
import { createProviderProxyResponse } from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("alpha-search-handler")

export const alphaSearchRoutes = new Hono()

function parseDebugBody<T>(body: string): T | string {
  try {
    return JSON.parse(body) as T
  } catch {
    return body
  }
}

/**
 * Handles Codex alpha-search proxying. Pass `resolvedProviderConfig` when the
 * caller already resolved the codex provider to avoid a second resolve.
 */
export async function handleCodexAlphaSearch(
  c: Context,
  resolvedProviderConfig?: ResolvedProviderConfig,
): Promise<Response> {
  const codexProviderConfig =
    resolvedProviderConfig ?? (await resolveProviderConfig("codex"))
  if (!codexProviderConfig) {
    if (
      isAlphaSearchResponsesFallbackEnabled()
      && isResponsesApiWebSearchEnabled()
    ) {
      return await handleCopilotAlphaSearch(c)
    }
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

  await debugJsonAsync(logger, "alpha_search.codex.request", async () => ({
    body: parseDebugBody<AlphaSearchRequest>(await c.req.raw.clone().text()),
  }))

  const upstreamResponse = await forwardCodexAlphaSearch(c.req.raw)
  await debugJsonAsync(logger, "alpha_search.codex.response", async () => ({
    body: parseDebugBody<AlphaSearchResponse>(
      await upstreamResponse.clone().text(),
    ),
    statusCode: upstreamResponse.status,
  }))
  return createProviderProxyResponse(upstreamResponse)
}

alphaSearchRoutes.post("/", async (c) => {
  try {
    return await handleCodexAlphaSearch(c)
  } catch (error) {
    logger.error("alpha_search.codex.error", { error })
    return await forwardError(c, error)
  }
})
