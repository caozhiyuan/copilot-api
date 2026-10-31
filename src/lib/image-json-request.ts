import {
  DuplicateImageModelError,
  createJsonByteSource,
  ImageModelReader,
  JSON_CHUNK_BYTES,
  jsonByteStream,
  rewriteImageModel,
  StreamingJsonReader,
} from "~/lib/streaming-json"
import { HTTPError } from "~/lib/error"

function invalidImageJson(
  message = "Image request body must be a JSON object",
) {
  return new HTTPError(
    message,
    Response.json(
      { error: { message, type: "invalid_request_error" } },
      { status: 400 },
    ),
  )
}

function rebuild(
  request: Request,
  body: ReadableStream<Uint8Array>,
  changed = false,
): Request {
  const headers = new Headers(request.headers)
  if (changed) headers.delete("content-length")
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
    duplex: "half",
  } as RequestInit)
}

/** Find the model or a complete object within 64 KiB, then stream the body. */
export async function prepareImageJsonRequest(request: Request) {
  const forwardingAbort = new AbortController()
  const signal = AbortSignal.any([request.signal, forwardingAbort.signal])
  const input = createJsonByteSource(
    request.body as ReadableStream<Uint8Array> | null,
    signal,
  )
  const bytes = input.bytes
  const parser = new StreamingJsonReader()
  const metadata = new ImageModelReader()
  const scan = (chunk?: Uint8Array) => {
    try {
      metadata.read(parser.read(chunk))
    } catch (error) {
      throw invalidImageJson(
        error instanceof DuplicateImageModelError ? error.message : undefined,
      )
    }
    if (metadata.invalidModel)
      throw invalidImageJson(
        "Image model must be a string of at most 4096 characters",
      )
  }
  const prefix: Array<Uint8Array> = []
  let length = 0
  let eof = false
  let pending: Uint8Array | undefined
  async function* remaining(): AsyncGenerator<Uint8Array, void, unknown> {
    if (pending) {
      const chunk = pending
      pending = undefined
      yield chunk
    }
    yield* bytes
  }
  try {
    while (length < JSON_CHUNK_BYTES) {
      const next = await bytes.next()
      if (next.done) {
        eof = true
        scan()
        break
      }
      const chunk = next.value.subarray(0, JSON_CHUNK_BYTES - length)
      pending =
        chunk.byteLength < next.value.byteLength ?
          next.value.subarray(chunk.byteLength)
        : undefined
      prefix.push(chunk)
      length += chunk.byteLength
      scan(chunk)
      if (metadata.model !== undefined || metadata.complete) break
    }
    if (!eof && !metadata.complete && metadata.model === undefined) {
      throw invalidImageJson(
        "Image model must appear within the first 64 KiB of the JSON body",
      )
    }
    if (!metadata.object) throw invalidImageJson()
  } catch (error) {
    await input.cancel(error)
    throw error
  }
  let claimed = false
  const abort = () => {
    void input.cancel().catch(() => {})
  }
  request.signal.addEventListener("abort", abort, { once: true })
  async function* source(): AsyncGenerator<Uint8Array, void, unknown> {
    if (claimed) throw new Error("Image request body already forwarded")
    claimed = true
    try {
      signal.throwIfAborted()
      yield* prefix
      prefix.length = 0
      if (!eof) {
        for await (const chunk of remaining()) {
          scan(chunk)
          yield chunk
        }
        scan()
      }
    } finally {
      request.signal.removeEventListener("abort", abort)
      await bytes.return(undefined).catch(() => {})
    }
  }
  const cancel = async (reason?: unknown) => {
    forwardingAbort.abort(reason)
    request.signal.removeEventListener("abort", abort)
    await input.cancel(reason)
  }
  return {
    model: metadata.model,
    originalRequest: rebuild(request, jsonByteStream(source(), cancel)),
    createRequest: (model: string) =>
      rebuild(
        request,
        jsonByteStream(
          rewriteImageModel(source(), model, metadata.model === undefined),
          cancel,
        ),
        true,
      ),
    cleanup: cancel,
  }
}
