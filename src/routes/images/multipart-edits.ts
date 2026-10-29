import type { Context } from "hono"

import {
  InvalidMultipartBodyError,
  MultipartBodyTooLargeError,
  stageMultipartBodyToDisk,
} from "~/routes/images/temp-form-data"
import {
  translateXaiImageEditJson,
  XaiImagesRequestError,
} from "~/services/xai/images"

export const multipartEditDependencies = { stageMultipartBodyToDisk }

class ImageEditRequestError extends Error {}

export function imageEditRequestErrorResponse(
  c: Context,
  error: unknown,
): Response | null {
  if (c.req.raw.signal.aborted) return null
  if (
    !(error instanceof ImageEditRequestError)
    && !(error instanceof InvalidMultipartBodyError)
    && !(error instanceof MultipartBodyTooLargeError)
    && !(error instanceof XaiImagesRequestError)
  ) {
    return null
  }

  return c.json(
    { error: { message: error.message, type: "invalid_request_error" } },
    error instanceof MultipartBodyTooLargeError ? 413 : 400,
  )
}

function imageMimeType(bytes: Buffer, declared: string): string {
  if (declared.startsWith("image/")) return declared
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png"
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"
  }
  if (
    bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp"
  }
  if (/^GIF8[79]a/u.test(bytes.toString("ascii", 0, 6))) return "image/gif"
  throw new ImageEditRequestError("Uploaded image must have an image MIME type")
}

async function imageReference(
  value: Exclude<ReturnType<FormData["get"]>, null>,
  signal: AbortSignal,
): Promise<{ image_url: string }> {
  signal.throwIfAborted()
  if (typeof value === "string") {
    const url = value.trim()
    if (!/^(?:https?:\/\/|data:image\/[a-z0-9.+-]+;base64,)/iu.test(url)) {
      throw new ImageEditRequestError(
        "image must be a file, HTTP URL or base64 data URL",
      )
    }
    return { image_url: url }
  }

  const bytes = Buffer.from(await value.arrayBuffer())
  signal.throwIfAborted()
  if (bytes.length === 0) throw new ImageEditRequestError("image is empty")
  const mime = imageMimeType(bytes, value.type.trim().toLowerCase())
  return { image_url: `data:${mime};base64,${bytes.toString("base64")}` }
}

function fieldValue(name: string, value: string): string | number | boolean {
  if (["n", "partial_images", "output_compression"].includes(name)) {
    const trimmed = value.trim()
    const number = Number(trimmed)
    if (!/^-?\d+$/u.test(trimmed) || !Number.isSafeInteger(number)) {
      throw new ImageEditRequestError(`${name} must be an integer`)
    }
    return number
  }
  if (name === "stream") {
    if (value.trim() === "true") return true
    if (value.trim() === "false") return false
    throw new ImageEditRequestError("stream must be true or false")
  }
  return value
}

async function formPayload(
  form: FormData,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const fields = new Map<string, unknown>()
  const images: Array<{ image_url: string }> = []
  for (const [name, value] of form.entries()) {
    if (name === "image" || name === "image[]") {
      images.push(await imageReference(value, signal))
      continue
    }
    const key = name === "mask[]" ? "mask" : name
    if (fields.has(key)) {
      throw new ImageEditRequestError(`Duplicate image edit field: ${key}`)
    }
    if (key === "mask") {
      fields.set(key, await imageReference(value, signal))
    } else if (typeof value === "string") {
      fields.set(key, fieldValue(key, value))
    } else {
      throw new ImageEditRequestError(
        `Unexpected image edit file field: ${key}`,
      )
    }
  }
  if (images.length === 0) throw new ImageEditRequestError("image is required")
  fields.set("images", images)
  return Object.fromEntries(fields)
}

/** Parse multipart once, keeping uploads on disk until the target is known. */
export async function parseMultipartImageEdit(request: Request) {
  const requestHeaders = new Headers(request.headers)
  const contentType = requestHeaders.get("content-type")
  if (
    contentType?.split(";", 1)[0]?.trim().toLowerCase()
    !== "multipart/form-data"
  ) {
    return null
  }

  const staged = await multipartEditDependencies.stageMultipartBodyToDisk(
    request.body,
    contentType,
    {},
    request.signal,
  )
  const form = staged.formData
  const model = form.get("model")
  let payloadPromise: Promise<Record<string, unknown>> | undefined
  const readPayload = () => {
    payloadPromise ??= formPayload(form, request.signal).finally(staged.cleanup)
    return payloadPromise
  }

  return {
    ...staged,
    model: typeof model === "string" ? model : undefined,
    readPayload,
    createRequest: async (
      model: string | undefined,
      provider = "codex",
    ): Promise<Request> => {
      const headers = new Headers(requestHeaders)
      headers.delete("content-length")
      let body: FormData | Uint8Array
      if (provider === "codex" || provider === "xai") {
        const payload = {
          ...(await readPayload()),
          ...(model === undefined ? {} : { model }),
        }
        if (provider === "xai" && !model) {
          throw new ImageEditRequestError(
            "model is required for xAI multipart edits",
          )
        }
        headers.set("content-type", "application/json")
        body = new TextEncoder().encode(
          JSON.stringify(
            provider === "xai" ?
              translateXaiImageEditJson(payload, model!)
            : payload,
          ),
        )
      } else {
        if (model !== undefined) form.set("model", model)
        headers.delete("content-type")
        body = form
      }
      request.signal.throwIfAborted()
      return new Request(request.url, {
        method: request.method,
        headers,
        body,
        signal: request.signal,
      })
    },
  }
}
