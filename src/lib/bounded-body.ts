export class BodySizeLimitExceededError extends Error {
  readonly maxBytes: number

  constructor(maxBytes: number) {
    super(`Body exceeds the configured size limit of ${maxBytes} bytes`)
    this.name = "BodySizeLimitExceededError"
    this.maxBytes = maxBytes
  }
}

function exceedsDeclaredSize(
  contentLength: string | null | undefined,
  maxBytes: number,
): boolean {
  if (!contentLength || !/^\d+$/u.test(contentLength)) return false

  const declaredSize = Number(contentLength)
  return !Number.isSafeInteger(declaredSize) || declaredSize > maxBytes
}

export function assertBodySizeWithinLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  contentLength?: string | null,
): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer")
  }

  if (exceedsDeclaredSize(contentLength, maxBytes)) {
    const error = new BodySizeLimitExceededError(maxBytes)
    void body?.cancel(error).catch(() => {})
    throw error
  }
}

export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  contentLength?: string | null,
): Promise<Uint8Array> {
  assertBodySizeWithinLimit(body, maxBytes, contentLength)
  if (!body) return new Uint8Array()

  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      size += value.byteLength
      if (size > maxBytes) {
        throw new BodySizeLimitExceededError(maxBytes)
      }
      chunks.push(value)
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }

  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}
