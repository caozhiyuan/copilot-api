import type { Context } from "hono"

import { forwardError } from "~/lib/error"
import {
  createForwardRequest,
  handleCodexImages,
  logger,
  routeImagesRequest,
  snapshotRequestHeaders,
} from "~/routes/images/shared"
import {
  InvalidMultipartBodyError,
  MultipartBodyTooLargeError,
  stageMultipartBodyToDisk,
  type StagedMultipartBody,
} from "~/routes/images/temp-form-data"

export const imageEditsRouteDependencies = {
  stageMultipartBodyToDisk,
}

export function createStagedFormDataRequest(
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

export interface StagedEditsRequest {
  model?: string
  requestHeaders: Headers
  staged: StagedMultipartBody
}

/**
 * Streams an edits multipart body to disk, staging uploaded files so
 * forwarding streams them from the filesystem instead of pinning them in
 * memory. Non-multipart bodies come back as an untouched request stream;
 * malformed multipart bodies throw a typed error because the consumed stream
 * can no longer be forwarded.
 */
export async function parseEditsRequest(
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

export async function handleImagesEdits(c: Context): Promise<Response> {
  try {
    const parsed = await parseEditsRequest(c.req.raw)
    if (parsed instanceof Request) {
      return await handleCodexImages(c, "edits", undefined, parsed)
    }

    const { model, requestHeaders, staged } = parsed
    try {
      const response =
        model === undefined ?
          await handleCodexImages(
            c,
            "edits",
            undefined,
            createStagedFormDataRequest(
              c.req.raw,
              requestHeaders,
              staged.formData,
            ),
          )
        : await routeImagesRequest(c, "edits", {
            createRequest: (mappedModel) =>
              createMultipartImagesRequest(
                c.req.raw,
                requestHeaders,
                staged.formData,
                mappedModel,
              ),
            model,
          })
      staged.scheduleCleanup()
      return response
    } catch (error) {
      await staged.cleanup()
      throw error
    }
  } catch (error) {
    if (
      error instanceof InvalidMultipartBodyError
      || error instanceof MultipartBodyTooLargeError
    ) {
      return c.json(
        {
          error: {
            message: error.message,
            type: "invalid_request_error",
          },
        },
        error instanceof MultipartBodyTooLargeError ? 413 : 400,
      )
    }

    logger.error("images.edits.error", { error })
    return await forwardError(c, error)
  }
}
