import type { Context } from "hono"

import { forwardError } from "~/lib/error"
import {
  createForwardRequest,
  handleCodexImages,
  logger,
  routeImagesRequest,
  snapshotRequestHeaders,
  type ParsedImagesRequest,
} from "~/routes/images/shared"

function createJsonImagesRequest(
  request: Request,
  requestHeaders: Headers,
  payload: Record<string, unknown>,
  model: string,
): Request {
  const headers = new Headers(requestHeaders)
  headers.delete("content-length")

  return createForwardRequest(
    request,
    headers,
    new TextEncoder().encode(JSON.stringify({ ...payload, model })),
  )
}

/**
 * Parses a generations request body as JSON. Generation payloads are small
 * JSON documents, so one byte copy covers both routing on the model field
 * and forwarding an unchanged body to Codex. Rebuilt bodies stay binary so
 * Node does not synthesize a text/plain content type.
 */
export async function parseGenerationsRequest(
  request: Request,
): Promise<ParsedImagesRequest | Request> {
  const requestHeaders = snapshotRequestHeaders(request)
  const body = new Uint8Array(await request.arrayBuffer())
  const originalRequest = createForwardRequest(request, requestHeaders, body)

  let payload: unknown
  try {
    const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(body)
    payload = JSON.parse(bodyText)
  } catch {
    return originalRequest
  }

  if (
    payload === null
    || typeof payload !== "object"
    || Array.isArray(payload)
    || typeof (payload as { model?: unknown }).model !== "string"
  ) {
    return originalRequest
  }

  const model = (payload as { model: string }).model
  return {
    createRequest: (mappedModel) =>
      createJsonImagesRequest(
        request,
        requestHeaders,
        payload as Record<string, unknown>,
        mappedModel,
      ),
    model,
    originalRequest,
  }
}

export async function handleImagesGenerations(c: Context): Promise<Response> {
  try {
    const parsed = await parseGenerationsRequest(c.req.raw)
    if (parsed instanceof Request) {
      return await handleCodexImages(c, "generations", undefined, parsed)
    }

    return await routeImagesRequest(c, "generations", parsed)
  } catch (error) {
    logger.error("images.generations.error", { error })
    return await forwardError(c, error)
  }
}
