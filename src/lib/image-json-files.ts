import { createReadStream, rmSync } from "node:fs"
import { mkdtemp, open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HTTPError } from "~/lib/error"
import { registerProcessCleanup } from "~/lib/process-cleanup"

export const IMAGE_JSON_MAX_BYTES = 512 * 1024 * 1024

export function imageJsonLimitError(): HTTPError {
  return new HTTPError(
    "Image JSON upload exceeds the staging limit",
    Response.json(
      {
        error: {
          message: "Image JSON upload exceeds the staging limit",
          type: "invalid_request_error",
        },
      },
      { status: 413 },
    ),
  )
}

/** Owns only an mkdtemp-created directory; callers never supply deletion paths. */
export async function createImageJsonFiles(ttlMs = 15 * 60 * 1000) {
  const directory = await mkdtemp(join(tmpdir(), "copilot-image-json-"))
  let index = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let cleanupPromise: Promise<void> | undefined
  const unregister = registerProcessCleanup(() => {
    if (timer) clearTimeout(timer)
    rmSync(directory, { recursive: true, force: true })
  })
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      if (timer) clearTimeout(timer)
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 20,
      })
      unregister()
    })()
    return cleanupPromise
  }
  return {
    directory,
    cleanup,
    scheduleCleanup() {
      if (timer || cleanupPromise) return
      timer = setTimeout(() => void cleanup().catch(() => {}), ttlMs)
      timer.unref()
    },
    async create() {
      const path = join(directory, String(index++))
      return { path, handle: await open(path, "wx") }
    },
  }
}

export async function* readImageJsonFile(
  path: string,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array, void, unknown> {
  const stream = createReadStream(path, { highWaterMark: 64 * 1024, signal })
  try {
    for await (const bytes of stream) yield bytes as Buffer
  } finally {
    stream.destroy()
  }
}
