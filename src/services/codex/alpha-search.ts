import { CODEX_API_BASE_URL } from "~/services/codex/constants"
import { buildCodexRequestHeaders } from "~/services/codex/create-responses"
import { recordNativeAlphaSearchUsage } from "~/lib/token-usage/alpha-search"

const CODEX_ALPHA_SEARCH_URL = `${CODEX_API_BASE_URL}/codex/alpha/search`

export function resolveCodexAlphaSearchUrl(requestUrl: string): string {
  const upstreamUrl = new URL(CODEX_ALPHA_SEARCH_URL)
  upstreamUrl.search = new URL(requestUrl, "http://localhost").search
  return upstreamUrl.toString()
}

export async function forwardCodexAlphaSearch(
  request: Request,
): Promise<Response> {
  const headers = buildCodexRequestHeaders(request.headers)
  if (!headers.has("accept")) {
    headers.set("accept", "application/json")
  }

  const body = await request.arrayBuffer()
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  const response = await fetch(resolveCodexAlphaSearchUrl(request.url), {
    method: "POST",
    headers,
    body,
  })
  await recordNativeAlphaSearchUsage(response, {
    providerName: "codex",
    requestBody: body,
    requestHeaders: request.headers,
  })
  return response
}
