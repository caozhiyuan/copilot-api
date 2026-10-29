import {
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici"

import { createTimeoutDispatcher } from "~/lib/timeout-dispatcher"
import {
  buildCodexRequestHeaders,
  CODEX_API_BASE_URL,
} from "~/services/codex/create-responses"

export type CodexImagesOperation = "generations" | "edits"

const CODEX_IMAGES_TIMEOUT_MS = 15 * 60 * 1000

const codexImagesDispatcher = createTimeoutDispatcher(CODEX_IMAGES_TIMEOUT_MS)

type StreamingRequestInit = RequestInit & {
  duplex: "half"
}

export function resolveCodexImagesUrl(
  requestUrl: string,
  operation: CodexImagesOperation,
): string {
  const upstreamUrl = new URL(`${CODEX_API_BASE_URL}/codex/images/${operation}`)
  upstreamUrl.search = new URL(requestUrl, "http://localhost").search
  return upstreamUrl.toString()
}

export async function forwardCodexImages(
  request: Request,
  operation: CodexImagesOperation,
): Promise<Response> {
  const headers = buildCodexRequestHeaders(request.headers)
  if (!headers.has("accept")) {
    headers.set("accept", "application/json")
  }

  if (operation === "generations" && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  const init: StreamingRequestInit = {
    method: "POST",
    headers,
    body: request.body,
    duplex: "half",
    signal: AbortSignal.any([
      request.signal,
      AbortSignal.timeout(CODEX_IMAGES_TIMEOUT_MS),
    ]),
  }

  const upstreamUrl = resolveCodexImagesUrl(request.url, operation)
  if (typeof Bun !== "undefined") {
    return await fetch(upstreamUrl, init)
  }

  // Node and Undici expose separate fetch types, but their streamed request
  // and response objects are runtime-compatible here.
  return (await undiciFetch(upstreamUrl, {
    ...init,
    dispatcher: codexImagesDispatcher,
  } as unknown as UndiciRequestInit)) as unknown as Response
}
