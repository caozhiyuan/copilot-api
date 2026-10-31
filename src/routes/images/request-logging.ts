import type { ConsolaInstance } from "consola"

import { debugJsonAsync } from "~/lib/logger"
import { ImageJsonValueReader } from "~/lib/image-json-value"
import { state } from "~/lib/state"
import {
  createJsonByteSource,
  jsonByteStream,
  StreamingJsonReader,
} from "~/lib/streaming-json"

const MULTIPART_LOG_FIELDS = new Set([
  "model",
  "prompt",
  "size",
  "quality",
  "n",
])
const MAX_MULTIPART_LOG_FIELD_LENGTH = 8 * 1024

function redactImageBase64(value: unknown, key = ""): unknown {
  if (["b64_json", "base64", "image_base64"].includes(key))
    return "[image base64 omitted]"
  if (typeof value === "string") {
    return /^data:image\/[^,]+;base64,/iu.test(value) ?
        "[image base64 omitted]"
      : value
  }
  if (Array.isArray(value))
    return value.map((item: unknown) => redactImageBase64(item))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([field, item]: [string, unknown]) => [
        field,
        redactImageBase64(item, field),
      ]),
    )
  }
  return value
}

function multipartLogFields(form: FormData | undefined) {
  if (!form) return []
  const fields: Array<{ name: string; value: unknown }> = []
  for (const name of MULTIPART_LOG_FIELDS) {
    for (const value of form.getAll(name)) {
      if (typeof value !== "string") continue
      const text =
        value.length > MAX_MULTIPART_LOG_FIELD_LENGTH ?
          `${value.slice(0, MAX_MULTIPART_LOG_FIELD_LENGTH)}[truncated]`
        : value
      fields.push({ name, value: redactImageBase64(text, name) })
    }
  }
  return fields
}

export async function logImageEditRequest(
  logger: ConsolaInstance,
  label: string,
  request: Request,
  extra: Record<string, unknown> = {},
  debug: typeof debugJsonAsync = debugJsonAsync,
  multipartForm?: FormData,
): Promise<Request> {
  if (!state.verbose) return request
  if (
    !multipartForm
    && !request.headers.get("content-type")?.includes("multipart/form-data")
  )
    return logImageJsonRequest(logger, label, request, extra, debug)
  await debug(logger, label, () =>
    Promise.resolve({
      contentType: request.headers.get("content-type"),
      contentLength: request.headers.get("content-length"),
      ...extra,
      body: multipartLogFields(multipartForm),
    }),
  )
  return request
}

/** Observes the same chunks sent upstream; debug logging never tees JSON bodies. */
function logImageJsonRequest(
  logger: ConsolaInstance,
  label: string,
  request: Request,
  extra: Record<string, unknown>,
  debug: typeof debugJsonAsync,
): Request {
  const value = new ImageJsonValueReader()
  const parser = new StreamingJsonReader()
  const input = createJsonByteSource(
    request.body as ReadableStream<Uint8Array> | null,
    request.signal,
  )
  let valid = true
  async function* observe(): AsyncGenerator<Uint8Array, void, unknown> {
    for await (const chunk of input.bytes) {
      if (valid) {
        try {
          await value.read(parser.read(chunk))
        } catch {
          valid = false
        }
      }
      yield chunk
    }
    if (valid) {
      try {
        await value.read(parser.read())
      } catch {
        valid = false
      }
    }
    await debug(logger, label, () =>
      Promise.resolve({
        contentType: request.headers.get("content-type"),
        contentLength: request.headers.get("content-length"),
        ...extra,
        body:
          valid ? redactImageBase64(value.value) : "[unavailable JSON body]",
      }),
    )
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    body: jsonByteStream(observe(), (reason) => input.cancel(reason)),
    duplex: "half",
  } as RequestInit)
}
