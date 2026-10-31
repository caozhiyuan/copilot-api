import {
  createImageJsonFiles,
  IMAGE_JSON_MAX_BYTES,
  imageJsonLimitError,
  readImageJsonFile,
} from "~/lib/image-json-files"
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

/** Read at most 64 KiB before forwarding a model-first request. Late models use disk. */
export async function prepareImageJsonRequest(
  request: Request,
  maxStagedBytes = IMAGE_JSON_MAX_BYTES,
) {
  const forwardingAbort = new AbortController()
  const signal = AbortSignal.any([request.signal, forwardingAbort.signal])
  const input = createJsonByteSource(
    request.body as ReadableStream<Uint8Array> | null,
    signal,
  )
  const bytes = input.bytes
  const parser = new StreamingJsonReader()
  const metadata = new ImageModelReader()
  let valid = true
  const scan = (chunk?: Uint8Array) => {
    if (!valid) return
    try {
      metadata.read(parser.read(chunk))
    } catch (error) {
      if (error instanceof DuplicateImageModelError) throw error
      valid = false
    }
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
  let files: Awaited<ReturnType<typeof createImageJsonFiles>> | undefined
  let stagedPath: string | undefined
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
      if (
        !valid
        || metadata.model !== undefined
        || metadata.invalidModel
        || metadata.complete
      )
        break
    }
    if (
      valid
      && !eof
      && !metadata.complete
      && metadata.model === undefined
      && !metadata.invalidModel
    ) {
      files = await createImageJsonFiles()
      const file = await files.create()
      stagedPath = file.path
      try {
        for (const chunk of prefix) {
          if (length > maxStagedBytes) throw imageJsonLimitError()
          await file.handle.writeFile(chunk)
        }
        prefix.length = 0
        for await (const chunk of remaining()) {
          length += chunk.byteLength
          if (length > maxStagedBytes) throw imageJsonLimitError()
          scan(chunk)
          await file.handle.writeFile(chunk)
        }
        eof = true
        scan()
      } finally {
        await file.handle.close()
      }
      files.scheduleCleanup()
    }
  } catch (error) {
    await input.cancel(error)
    await files?.cleanup()
    if (error instanceof DuplicateImageModelError)
      throw new HTTPError(
        error.message,
        Response.json(
          { error: { message: error.message, type: "invalid_request_error" } },
          { status: 400 },
        ),
      )
    throw error
  }
  let claimed = false
  const abort = () => {
    void input.cancel().catch(() => {})
    void files?.cleanup().catch(() => {})
  }
  request.signal.addEventListener("abort", abort, { once: true })
  async function* source(): AsyncGenerator<Uint8Array, void, unknown> {
    if (claimed) throw new Error("Image request body already forwarded")
    claimed = true
    try {
      signal.throwIfAborted()
      if (stagedPath) yield* readImageJsonFile(stagedPath, signal)
      else {
        yield* prefix
        prefix.length = 0
        if (!eof) {
          for await (const chunk of remaining()) {
            scan(chunk)
            yield chunk
          }
          scan()
        }
      }
    } finally {
      request.signal.removeEventListener("abort", abort)
      await bytes.return(undefined).catch(() => {})
      await files?.cleanup()
    }
  }
  const cancel = async (reason?: unknown) => {
    forwardingAbort.abort(reason)
    request.signal.removeEventListener("abort", abort)
    await input.cancel(reason)
    await files?.cleanup()
  }
  return {
    valid: valid && metadata.object && !metadata.invalidModel,
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
    stagedDirectory: files?.directory,
  }
}
