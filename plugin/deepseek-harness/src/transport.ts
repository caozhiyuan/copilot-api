import { attributionHeaders } from "@deepseek-ai/dsh-llm"
import type { SimpleStreamOptions } from "@earendil-works/pi-ai"
import type { Settings } from "./config.ts"

const reserved = new Set([
  "authorization", "x-api-key", "anthropic-version", "content-type", "accept",
  "user-agent", "host", "content-length", "x-deepseek-harness-session-id", "x-session-affinity",
])

/** Merge names case-insensitively while preserving SDK beta and streaming headers. */
export function gatewayHeaders(config: Settings, apiKey: string, sdkHeaders?: HeadersInit, options?: Pick<SimpleStreamOptions, "sessionId">): Headers {
  const headers = new Headers(sdkHeaders)
  for (const [name, value] of Object.entries(config.headers)) {
    const lower = name.toLowerCase()
    if (reserved.has(lower)) continue
    if (lower === "anthropic-beta") {
      const tokens = [headers.get(lower) ?? "", value].flatMap(part => part.split(",").map(token => token.trim()).filter(Boolean))
      headers.set(lower, [...new Set(tokens)].join(","))
    } else headers.set(lower, value)
  }
  headers.delete("authorization")
  headers.delete("x-api-key")
  if (config.protocol === "openai-responses") headers.set("authorization", `Bearer ${apiKey}`)
  else {
    headers.set("x-api-key", apiKey)
    headers.set("anthropic-version", "2023-06-01")
  }
  headers.set("content-type", "application/json")
  if (options === undefined) headers.set("accept", "application/json")
  for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
  headers.delete("x-deepseek-harness-session-id")
  headers.delete("x-session-affinity")
  if (options?.sessionId !== undefined) {
    const sessionId = String(options.sessionId)
    headers.set("x-deepseek-harness-session-id", sessionId)
    if (config.sessionAffinity) headers.set("x-session-affinity", sessionId)
    // pi-ai reuses sessionId for this header even on custom Responses routes.
    // A cache/session identity is not a unique request identity.
    if (headers.get("x-client-request-id") === sessionId) headers.delete("x-client-request-id")
  }
  return headers
}

/** Transport only: leave URLs, bodies, prompt_cache_key, SSE and signals with pi-ai. */
export function gatewayFetch(config: Settings, apiKey: string, options: Pick<SimpleStreamOptions, "sessionId">): typeof fetch {
  return (input, init) => {
    const request = new Request(input, init)
    return globalThis.fetch(request, {
      headers: gatewayHeaders(config, apiKey, request.headers, options),
      redirect: "error",
    })
  }
}
