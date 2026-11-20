import { none } from "stream-chain/core"
import { jsonParser, type Token } from "stream-json/core/parser.js"
import stringer from "stream-json/core/stringer.js"

export type JsonToken = Token
export const JSON_CHUNK_BYTES = 64 * 1024

/** Never ask the tokenizer to accumulate untrusted strings, keys, or numbers. */
export class StreamingJsonReader {
  private readonly decode = new TextDecoder("utf-8", { fatal: true })
  private readonly parse = jsonParser({ packValues: false }) as (
    input: string | typeof none,
  ) => ReturnType<ReturnType<typeof jsonParser>>
  private depth = 0
  private scalarLength = 0
  private boundedScalar = false

  read(bytes?: Uint8Array): Array<JsonToken> {
    const text = this.decode.decode(bytes, { stream: bytes !== undefined })
    const result = this.parse(text)
    const tokens = result === none ? [] : result.values
    if (bytes === undefined) {
      const last = this.parse(none)
      if (last !== none) tokens.push(...last.values)
    }
    for (const token of tokens) {
      switch (token.name) {
        case "startObject":
        case "startArray":
          if (++this.depth > 64)
            throw new SyntaxError("JSON nesting exceeds 64")
          break
        case "endObject":
        case "endArray":
          this.depth--
          break
        case "startKey":
        case "startNumber":
          this.scalarLength = 0
          this.boundedScalar = true
          break
        case "endKey":
        case "endNumber":
          this.boundedScalar = false
          break
        case "stringChunk":
        case "numberChunk":
          if (this.boundedScalar) {
            this.scalarLength += token.value.length
            if (this.scalarLength > JSON_CHUNK_BYTES)
              throw new SyntaxError("JSON key or number is too large")
          }
      }
    }
    return tokens
  }
}

/** Splitting also bounds tokenizer allocations when a runtime supplies a huge chunk. */
export async function* readJsonBytes(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array, void, unknown> {
  if (!body) return
  const reader = body.getReader()
  const abort = () => void reader.cancel(signal?.reason).catch(() => {})
  signal?.addEventListener("abort", abort, { once: true })
  let complete = false
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) {
        complete = true
        return
      }
      for (
        let offset = 0;
        offset < value.byteLength;
        offset += JSON_CHUNK_BYTES
      )
        yield value.subarray(offset, offset + JSON_CHUNK_BYTES)
    }
  } finally {
    signal?.removeEventListener("abort", abort)
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function createJsonByteSource(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
) {
  const controller = new AbortController()
  const bytes = readJsonBytes(
    body,
    AbortSignal.any([signal, controller.signal]),
  )
  return {
    bytes,
    async cancel(reason?: unknown) {
      controller.abort(reason)
      await bytes.return(undefined).catch(() => {})
      if (body && !body.locked) await body.cancel(reason).catch(() => {})
    },
  }
}

/** Lazy streams allow a route to choose the original or rebuilt body without teeing. */
export function jsonByteStream(
  iterator: AsyncGenerator<Uint8Array, void, unknown>,
  cancel?: (reason: unknown) => Promise<unknown>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await iterator.next()
          if (done) controller.close()
          else controller.enqueue(value)
        } catch (error) {
          controller.error(error)
          await iterator.return(undefined).catch(() => {})
        }
      },
      async cancel(reason) {
        await cancel?.(reason)
        await iterator.return(undefined)
      },
    },
    { highWaterMark: 0 },
  )
}

export class DuplicateImageModelError extends SyntaxError {
  constructor() {
    super("Duplicate top-level image model")
  }
}

/** Keeps only the top-level model; all image string chunks are discarded. */
export class ImageModelReader {
  model: string | undefined
  object = false
  complete = false
  invalidModel = false
  private depth = 0
  private key = ""
  private inKey = false
  private readingModel = false
  private modelText = ""
  private seenModel = false

  read(tokens: Array<JsonToken>): void {
    for (const token of tokens) {
      if (token.name === "startKey") {
        this.inKey = true
        this.key = ""
      } else if (token.name === "endKey") {
        this.inKey = false
        if (this.depth === 1 && this.key === "model") {
          if (this.seenModel) throw new DuplicateImageModelError()
          this.seenModel = true
        }
      } else if (token.name === "stringChunk") {
        if (this.inKey) this.key += token.value
        else if (this.readingModel) {
          this.modelText += token.value
          if (this.modelText.length > 4096) {
            this.invalidModel = true
            this.readingModel = false
            this.modelText = ""
          }
        }
      } else if (token.name === "startString") {
        this.readingModel = this.depth === 1 && this.key === "model"
      } else if (token.name === "endString") {
        if (this.readingModel) {
          this.model = this.modelText
          this.modelText = ""
          this.readingModel = false
        }
      } else if (
        this.depth === 1
        && this.key === "model"
        && [
          "startObject",
          "startArray",
          "startNumber",
          "nullValue",
          "trueValue",
          "falseValue",
        ].includes(token.name)
      ) {
        this.invalidModel = true
      }
      if (token.name === "startObject" || token.name === "startArray") {
        if (this.depth === 0) this.object = token.name === "startObject"
        this.depth++
      } else if (token.name === "endObject" || token.name === "endArray") {
        if (--this.depth === 0) this.complete = true
      }
    }
  }
}

/** Re-encodes bounded chunks, replacing or inserting the top-level model. */
export async function* rewriteImageModel(
  input: AsyncIterable<Uint8Array>,
  model: string,
  insertModel = false,
): AsyncGenerator<Uint8Array, void, unknown> {
  const parser = new StreamingJsonReader()
  const encode = new TextEncoder()
  const stringify = stringer()
  let depth = 0
  let key = ""
  let inKey = false
  let replacing = false
  const process = (tokens: Array<JsonToken>): Uint8Array => {
    const parts: Array<string> = []
    const emit = (token: JsonToken) => {
      const text = stringify(token)
      if (text !== none) parts.push(text)
    }
    for (const token of tokens) {
      if (insertModel && depth === 0 && token.name === "startObject") {
        emit(token)
        emit({ name: "startKey" })
        emit({ name: "stringChunk", value: "model" })
        emit({ name: "endKey" })
        emit({ name: "startString" })
        emit({ name: "stringChunk", value: model })
        emit({ name: "endString" })
        depth++
        continue
      }
      if (replacing) {
        if (token.name === "endString") replacing = false
        continue
      }
      if (token.name === "startKey") {
        inKey = true
        key = ""
      } else if (token.name === "endKey") inKey = false
      else if (token.name === "stringChunk" && inKey) key += token.value
      if (token.name === "startString" && depth === 1 && key === "model") {
        emit(token)
        emit({ name: "stringChunk", value: model })
        emit({ name: "endString" })
        replacing = true
        continue
      }
      emit(token)
      if (token.name === "startObject" || token.name === "startArray") depth++
      else if (token.name === "endObject" || token.name === "endArray") depth--
    }
    return encode.encode(parts.join(""))
  }
  for await (const bytes of input) yield process(parser.read(bytes))
  const tail = process(parser.read())
  if (tail.byteLength) yield tail
}
