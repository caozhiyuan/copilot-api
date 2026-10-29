import { Busboy, type BusboyInstance } from "@fastify/busboy"
import { createWriteStream, rmSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Transform, type Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"

import { createHandlerLogger } from "~/lib/logger"
import { registerProcessCleanup } from "~/lib/process-cleanup"

const logger = createHandlerLogger("images-temp-form-data")

export const multipartStagingDependencies: {
  createWriteStream: (filePath: string) => Writable
} = {
  createWriteStream,
}

/**
 * Matches the images forwarding timeouts: an upstream upload may take that
 * long, so staged files must survive at least the whole forwarding window.
 */
const STAGED_FILES_TTL_MS = 15 * 60 * 1000

export interface MultipartStagingLimits {
  maxBodySizeBytes: number
  maxFieldSizeBytes: number
  maxFields: number
  maxFileSizeBytes: number
  maxFiles: number
  maxParts: number
}

export const DEFAULT_MULTIPART_STAGING_LIMITS: Readonly<MultipartStagingLimits> =
  {
    maxBodySizeBytes: 128 * 1024 * 1024,
    maxFieldSizeBytes: 10 * 1024 * 1024,
    maxFields: 64,
    maxFileSizeBytes: 64 * 1024 * 1024,
    maxFiles: 16,
    maxParts: 80,
  }

export class InvalidMultipartBodyError extends Error {
  constructor(options?: ErrorOptions) {
    super("Invalid multipart form data body", options)
    this.name = "InvalidMultipartBodyError"
  }
}

export class MultipartBodyTooLargeError extends Error {
  constructor() {
    super("Multipart form data body exceeds the configured upload limits")
    this.name = "MultipartBodyTooLargeError"
  }
}

export interface StagedMultipartBody {
  /** Temporary directory holding the staged files. */
  directory: string
  /** Rebuilt form data whose file entries stream from disk. */
  formData: FormData
  /** Removes the staged files now; use when forwarding never started. */
  cleanup: () => Promise<void>
  /** Removes the staged files once the forwarding window has passed. */
  scheduleCleanup: () => void
}

function sanitizeFileName(name: string): string {
  const baseName = name.split(/[\\/]/).pop()?.replaceAll("\0", "")
  return baseName || "file"
}

async function createDiskBackedBlob(
  filePath: string,
  type: string,
): Promise<Blob> {
  if (typeof Bun !== "undefined") {
    return Bun.file(filePath, { type })
  }

  const { openAsBlob } = await import("node:fs")
  return await openAsBlob(filePath, { type })
}

type StagedEntry =
  | { kind: "field"; name: string; value: string }
  | {
      fileName: string
      filePath: string
      kind: "file"
      mimeType: string
      name: string
    }

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function parseMultipartBody(
  body: ReadableStream<Uint8Array> | null,
  contentType: string,
  directory: string,
  entries: Array<StagedEntry>,
  limits: MultipartStagingLimits,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let busboy: BusboyInstance
    try {
      busboy = new Busboy({
        headers: { "content-type": contentType },
        limits: {
          fieldSize: limits.maxFieldSizeBytes,
          fields: limits.maxFields,
          fileSize: limits.maxFileSizeBytes,
          files: limits.maxFiles,
          parts: limits.maxParts,
        },
      })
    } catch (error) {
      reject(
        new InvalidMultipartBodyError({
          cause: toError(error),
        }),
      )
      return
    }

    const pendingWrites: Array<Promise<void>> = []
    const activeFileStreams = new Set<Readable>()
    const source =
      body === null ?
        Readable.from([])
      : Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>)
    let bodySizeBytes = 0
    const bodyLimiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bodySizeBytes += chunk.byteLength
        if (bodySizeBytes > limits.maxBodySizeBytes) {
          callback(new MultipartBodyTooLargeError())
          return
        }
        callback(null, chunk)
      },
    })
    let fileIndex = 0
    let failure: Error | null = null
    let inputPipeline: Promise<void> | null = null
    let settled = false

    const settleStreams = () =>
      Promise.allSettled([
        ...(inputPipeline ? [inputPipeline] : []),
        ...pendingWrites,
      ])
    const fail = (error: unknown) => {
      if (failure || settled) return

      const failureError = toError(error)
      failure = failureError
      source.destroy(failureError)
      bodyLimiter.destroy(failureError)
      busboy.destroy(failureError)
      for (const stream of activeFileStreams) {
        stream.destroy(failureError)
      }

      void settleStreams().then(() => {
        if (settled) return
        settled = true
        reject(failureError)
      })
    }

    const failLimit = () => fail(new MultipartBodyTooLargeError())

    busboy.on("field", (name, value, nameTruncated, valueTruncated) => {
      if (nameTruncated || valueTruncated) {
        failLimit()
        return
      }
      entries.push({ kind: "field", name, value })
    })
    busboy.on("file", (name, stream, fileName, _transferEncoding, mimeType) => {
      if (failure) {
        stream.resume()
        return
      }

      const filePath = join(directory, `${fileIndex}.upload`)
      fileIndex += 1
      entries.push({
        fileName: sanitizeFileName(fileName),
        filePath,
        kind: "file",
        mimeType,
        name,
      })

      activeFileStreams.add(stream)
      stream.once("error", fail)
      stream.once("close", () => activeFileStreams.delete(stream))
      stream.once("limit", failLimit)

      try {
        const write = pipeline(
          stream,
          multipartStagingDependencies.createWriteStream(filePath),
        )
        pendingWrites.push(write)
        void write.catch(fail)
      } catch (error) {
        fail(error)
      }
    })
    busboy.on("fieldsLimit", failLimit)
    busboy.on("filesLimit", failLimit)
    busboy.on("partsLimit", failLimit)

    inputPipeline = pipeline(source, bodyLimiter, busboy, { signal })
    void inputPipeline.then(
      () => {
        void Promise.allSettled(pendingWrites).then((results) => {
          if (failure || settled) return

          const failed = results.find(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          if (failed) {
            fail(failed.reason)
          } else {
            settled = true
            resolve()
          }
        })
      },
      (error) => {
        fail(
          error instanceof MultipartBodyTooLargeError || signal?.aborted ?
            error
          : new InvalidMultipartBodyError({ cause: toError(error) }),
        )
      },
    )
  })
}

function resolveStagingLimits(
  overrides: Partial<MultipartStagingLimits>,
): MultipartStagingLimits {
  const limits = { ...DEFAULT_MULTIPART_STAGING_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`)
    }
  }
  return limits
}

/**
 * Streams a multipart request body through the parser, writing every file
 * part to a temporary directory as it arrives and rebuilding the form data
 * with disk-backed blobs, so forwarding streams payloads from disk instead
 * of pinning the whole upload in memory.
 */
export async function stageMultipartBodyToDisk(
  body: ReadableStream<Uint8Array> | null,
  contentType: string,
  limitOverrides: Partial<MultipartStagingLimits> = {},
  signal?: AbortSignal,
): Promise<StagedMultipartBody> {
  signal?.throwIfAborted()
  const limits = resolveStagingLimits(limitOverrides)
  const directory = await mkdtemp(join(tmpdir(), "copilot-api-images-"))
  const entries: Array<StagedEntry> = []

  try {
    await parseMultipartBody(
      body,
      contentType,
      directory,
      entries,
      limits,
      signal,
    )
  } catch (error) {
    await rm(directory, { force: true, recursive: true })
    throw error
  }

  const stagedFormData = new FormData()
  try {
    for (const entry of entries) {
      if (entry.kind === "field") {
        stagedFormData.append(entry.name, entry.value)
      } else {
        stagedFormData.append(
          entry.name,
          await createDiskBackedBlob(entry.filePath, entry.mimeType),
          entry.fileName,
        )
      }
    }
  } catch (error) {
    await rm(directory, { force: true, recursive: true })
    throw error
  }

  let cleanupPromise: Promise<void> | null = null
  let cleanupTimer: ReturnType<typeof setTimeout> | null = null
  let unregisterProcessCleanup: (() => void) | null = null
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      if (cleanupTimer) {
        clearTimeout(cleanupTimer)
        cleanupTimer = null
      }

      try {
        await rm(directory, { force: true, recursive: true })
      } catch (error) {
        logger.warn("Failed to remove staged images temp directory", {
          directory,
          error,
        })
      } finally {
        unregisterProcessCleanup?.()
        unregisterProcessCleanup = null
      }
    })()
    return cleanupPromise
  }
  unregisterProcessCleanup = registerProcessCleanup(() => {
    if (cleanupTimer) {
      clearTimeout(cleanupTimer)
      cleanupTimer = null
    }
    try {
      rmSync(directory, { force: true, recursive: true })
    } catch (error) {
      logger.warn("Failed to remove staged images temp directory on exit", {
        directory,
        error,
      })
    } finally {
      unregisterProcessCleanup?.()
      unregisterProcessCleanup = null
    }
  })

  return {
    directory,
    formData: stagedFormData,
    cleanup,
    scheduleCleanup: () => {
      if (cleanupPromise || cleanupTimer) return
      cleanupTimer = setTimeout(() => void cleanup(), STAGED_FILES_TTL_MS)
      cleanupTimer.unref()
    },
  }
}
