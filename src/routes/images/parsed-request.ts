import { readBodyWithLimit } from "~/lib/bounded-body"
import {
  createForwardRequest,
  snapshotRequestHeaders,
  type ParsedImagesRequest,
} from "~/routes/images/shared"
import {
  stageMultipartBodyToDisk,
  type StagedMultipartBody,
} from "~/routes/images/temp-form-data"
import type { CodexImagesOperation } from "~/services/codex/images"

export const imageEditsRouteDependencies = {
  stageMultipartBodyToDisk,
}

export const MAX_IMAGE_GENERATION_BODY_SIZE_BYTES = 1024 * 1024

interface StagedEditsRequest {
  model?: string
  requestHeaders: Headers
  staged: StagedMultipartBody
}

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

function createStagedFormDataRequest(
  request: Request,
  requestHeaders: Headers,
  formData: FormData,
): Request {
  const headers = new Headers(requestHeaders)
  headers.delete("content-length")
  headers.delete("content-type")
  return createForwardRequest(request, headers, formData)
}

function createMultipartImagesRequest(
  request: Request,
  requestHeaders: Headers,
  formData: FormData,
  model: string,
): Request {
  formData.set("model", model)
  return createStagedFormDataRequest(request, requestHeaders, formData)
}

async function parseGenerationsRequest(
  request: Request,
): Promise<ParsedImagesRequest | Request> {
  const requestHeaders = snapshotRequestHeaders(request)
  const body = await readBodyWithLimit(
    request.body,
    MAX_IMAGE_GENERATION_BODY_SIZE_BYTES,
    requestHeaders.get("content-length"),
  )
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
  }
}

async function parseEditsRequest(
  request: Request,
): Promise<StagedEditsRequest | Request> {
  const requestHeaders = snapshotRequestHeaders(request)
  const contentType = requestHeaders.get("content-type")
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType !== "multipart/form-data" || !contentType) {
    return createForwardRequest(request, requestHeaders, request.body)
  }

  const staged = await imageEditsRouteDependencies.stageMultipartBodyToDisk(
    request.body,
    contentType,
  )
  const model = staged.formData.get("model")
  return {
    model: typeof model === "string" ? model : undefined,
    requestHeaders,
    staged,
  }
}

function trackBodyCompletion(
  request: Request,
  onStart: () => void,
  cleanup: () => Promise<void>,
): Request {
  if (!request.body) {
    void cleanup()
    return request
  }

  const reader = (request.body as ReadableStream<Uint8Array>).getReader()
  let complete = false
  let started = false
  const finish = async () => {
    if (complete) return
    complete = true
    await cleanup()
  }
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (!started) {
          started = true
          onStart()
        }
        try {
          const result = await reader.read()
          if (result.done) {
            controller.close()
            await finish()
          } else {
            controller.enqueue(result.value)
          }
        } catch (error) {
          controller.error(error)
          await finish()
        }
      },
      async cancel(reason: unknown) {
        try {
          await reader.cancel(reason)
        } finally {
          await finish()
        }
      },
    },
    { highWaterMark: 0 },
  )

  return createForwardRequest(request, new Headers(request.headers), body)
}

export async function withParsedImagesRequest<T>(
  request: Request,
  operation: CodexImagesOperation,
  handle: (parsed: ParsedImagesRequest | Request) => Promise<T>,
): Promise<T> {
  if (operation === "generations") {
    return await handle(await parseGenerationsRequest(request))
  }

  const parsed = await parseEditsRequest(request)
  if (parsed instanceof Request) {
    return await handle(parsed)
  }

  const { model, requestHeaders, staged } = parsed
  let forwardingStarted = false
  const trackRequest = (forwardRequest: Request): Request =>
    trackBodyCompletion(
      forwardRequest,
      () => {
        forwardingStarted = true
      },
      staged.cleanup,
    )
  const prepared =
    model === undefined ?
      trackRequest(
        createStagedFormDataRequest(request, requestHeaders, staged.formData),
      )
    : {
        createRequest: (mappedModel: string) =>
          trackRequest(
            createMultipartImagesRequest(
              request,
              requestHeaders,
              staged.formData,
              mappedModel,
            ),
          ),
        model,
      }

  try {
    const result = await handle(prepared)
    if (forwardingStarted) staged.scheduleCleanup()
    else await staged.cleanup()
    return result
  } catch (error) {
    await staged.cleanup()
    throw error
  }
}
