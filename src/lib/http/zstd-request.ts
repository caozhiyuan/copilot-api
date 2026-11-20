import type { MiddlewareHandler } from "hono"

import { decompress as decompressFallback } from "fzstd"

type BinaryData = ArrayBuffer | ArrayBufferView

type BunRuntime = {
  zstdDecompress?: (input: Uint8Array) => BinaryData | Promise<BinaryData>
}

type NodeZlibModule = {
  zstdDecompress?: (
    input: Uint8Array,
    callback: (error: Error | null, result: Uint8Array) => void,
  ) => void
}

const ZSTD_CONTENT_ENCODING = "zstd"
const INVALID_BODY_STATUS = 400

let nodeZlibPromise: Promise<NodeZlibModule | null> | null = null

export const zstdDecompressionMiddleware: MiddlewareHandler = async (
  c,
  next,
) => {
  const contentEncoding = c.req.header("content-encoding")?.trim().toLowerCase()
  if (contentEncoding !== ZSTD_CONTENT_ENCODING) {
    return next()
  }

  try {
    const compressedBody = new Uint8Array(await c.req.raw.arrayBuffer())
    const decompressedBody = await decompressZstd(compressedBody)
    const headers = new Headers(c.req.raw.headers)
    headers.delete("content-encoding")
    headers.delete("content-length")

    c.req.raw = new Request(c.req.raw.url, {
      body: decompressedBody,
      headers,
      method: c.req.raw.method,
      signal: c.req.raw.signal,
    })
    c.req.bodyCache = {}
  } catch {
    return c.json(
      {
        error: {
          message: "Failed to decompress zstd request body.",
          type: "invalid_request_error",
        },
      },
      INVALID_BODY_STATUS,
    )
  }

  return next()
}

const decompressZstd = async (input: Uint8Array): Promise<Uint8Array> => {
  const bun = getBunRuntime()
  if (bun?.zstdDecompress) {
    return toUint8Array(await bun.zstdDecompress(input))
  }

  const nodeZlib = await getNodeZlib()
  if (nodeZlib?.zstdDecompress) {
    return new Promise((resolve, reject) => {
      nodeZlib.zstdDecompress?.(input, (error, result) => {
        if (error) {
          reject(error)
          return
        }

        resolve(toUint8Array(result))
      })
    })
  }

  return decompressFallback(input)
}

const getBunRuntime = (): BunRuntime | undefined =>
  (globalThis as { Bun?: BunRuntime }).Bun

const getNodeZlib = async (): Promise<NodeZlibModule | null> => {
  nodeZlibPromise ??= import("node:zlib")
    .then((module) => module as NodeZlibModule)
    .catch(() => null)

  return nodeZlibPromise
}

const toUint8Array = (data: BinaryData): Uint8Array => {
  if (data instanceof Uint8Array) {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}
