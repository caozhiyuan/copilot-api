import { randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import type { FileHandle } from "node:fs/promises"

import {
  createImageJsonFiles,
  IMAGE_JSON_MAX_BYTES,
  imageJsonLimitError,
} from "~/lib/images/image-json-files"
import {
  jsonByteStream,
  readJsonBytes,
  StreamingJsonReader,
  type JsonToken,
} from "~/lib/http/streaming-json"

const STRING_LIMIT = 64 * 1024
const METADATA_LIMIT = 1024 * 1024

interface ExternalString {
  placeholder: string
  path: string
  mode: "compact" | "trim" | "identity"
  first: number
  end: number
  length: number
  prefix: string
  invalidBase64: boolean
  padding: number
}

interface StringValue {
  text: string
  mode: ExternalString["mode"]
  external?: ExternalString
  handle?: FileHandle
  pending: Array<string>
}

interface Frame {
  value: Record<string, unknown> | Array<unknown>
  key: string
  field: string
}

/** Builds bounded metadata, optionally storing large decoded strings on disk. */
export class ImageJsonValueReader {
  value: unknown
  readonly external: Array<ExternalString> = []
  private readonly stack: Array<Frame> = []
  private key = ""
  private inKey = false
  private number = ""
  private string?: StringValue
  private metadataSize = 0
  private files?: Awaited<ReturnType<typeof createImageJsonFiles>>

  private readonly externalize: boolean

  constructor(externalize = false) {
    this.externalize = externalize
  }

  private charge(size: number) {
    this.metadataSize += size
    if (this.metadataSize > METADATA_LIMIT)
      throw new SyntaxError("Image JSON metadata exceeds 1 MiB")
  }

  private add(value: unknown) {
    this.charge(16)
    const frame = this.stack.at(-1)
    if (!frame) this.value = value
    else if (Array.isArray(frame.value)) frame.value.push(value)
    else frame.value[frame.key] = value
  }

  private field(): string {
    const frame = this.stack.at(-1)
    return (
      frame ?
        Array.isArray(frame.value) ?
          frame.field
        : frame.key
      : ""
    )
  }

  private async append(text: string) {
    const value = this.string!
    if (!value.external && value.text.length + text.length <= STRING_LIMIT) {
      value.text += text
      return
    }
    if (!this.externalize) {
      value.text = "[large string omitted]"
      // Keep discarding subsequent chunks without accumulating them again.
      value.external ??= {
        placeholder: value.text,
        path: "",
        mode: value.mode,
        first: 0,
        end: 0,
        length: 0,
        prefix: "",
        invalidBase64: false,
        padding: 0,
      }
      return
    }
    if (!value.external) {
      if (this.external.length >= 64)
        throw new SyntaxError("Too many large image JSON strings")
      this.files ??= await createImageJsonFiles()
      const file = await this.files.create()
      const marker = randomBytes(24).toString("hex")
      value.external = {
        placeholder: marker,
        path: file.path,
        mode: value.mode,
        first: -1,
        end: 0,
        length: 0,
        prefix: "",
        invalidBase64: false,
        padding: 0,
      }
      value.handle = file.handle
      this.external.push(value.external)
      this.track(value.text)
      value.pending.push(value.text)
      value.text = ""
    }
    this.track(text)
    value.pending.push(text)
  }

  private track(text: string) {
    const value = this.string!.external!
    const first = text.search(/\S/u)
    if (first !== -1) {
      if (value.first === -1) value.first = value.length + first
      value.end = value.length + text.trimEnd().length
    }
    value.length += text.length
    const normalized =
      value.mode === "compact" ? text.replaceAll(/\s+/gu, "")
      : value.prefix ? text
      : text.trimStart()
    if (value.prefix.length < 256)
      value.prefix = (value.prefix + normalized).slice(0, 256)
    if (value.mode === "compact") {
      if (value.padding && /[^=]/u.test(normalized)) value.invalidBase64 = true
      if (!/^[a-z0-9+/]*={0,2}$/iu.test(normalized)) value.invalidBase64 = true
      value.padding += normalized.length - normalized.replaceAll("=", "").length
      if (value.padding > 2) value.invalidBase64 = true
    }
  }

  private async flushString() {
    const value = this.string
    if (value?.handle && value.pending.length) {
      await value.handle.writeFile(
        Buffer.from(value.pending.join(""), "utf16le"),
      )
      value.pending = []
    }
  }

  async read(tokens: Array<JsonToken>): Promise<void> {
    for (const token of tokens) {
      switch (token.name) {
        case "startObject":
        case "startArray": {
          const field = this.field()
          const value: Frame["value"] =
            token.name === "startArray" ?
              []
            : (Object.create(null) as Record<string, unknown>)
          this.add(value)
          this.stack.push({ value, key: "", field })
          break
        }
        case "endObject":
        case "endArray":
          this.stack.pop()
          break
        case "startKey":
          this.inKey = true
          this.key = ""
          break
        case "endKey":
          this.inKey = false
          this.charge(this.key.length)
          this.stack.at(-1)!.key = this.key
          break
        case "startString": {
          const field = this.field()
          this.string = {
            text: "",
            pending: [],
            mode:
              field === "b64_json" ? "compact"
              : ["image", "images", "url", "image_url"].includes(field) ? "trim"
              : "identity",
          }
          break
        }
        case "stringChunk":
          if (this.inKey) this.key += token.value
          else await this.append(token.value)
          break
        case "endString": {
          await this.flushString()
          const value = this.string!
          await value.handle?.close()
          value.handle = undefined
          if (value.external && this.externalize) {
            const external = value.external
            const prefix =
              /^(?:https?:\/\/|data:image\/[a-z0-9.+-]+;base64,)/iu.exec(
                external.prefix,
              )?.[0] ?? ""
            external.placeholder = prefix + external.placeholder
            this.add(external.first === -1 ? "" : external.placeholder)
          } else {
            this.charge(value.text.length)
            this.add(value.text)
          }
          this.string = undefined
          break
        }
        case "startNumber":
          this.number = ""
          break
        case "numberChunk":
          this.number += token.value
          break
        case "endNumber":
          this.add(Number(this.number))
          break
        case "trueValue":
          this.add(true)
          break
        case "falseValue":
          this.add(false)
          break
        case "nullValue":
          this.add(null)
          break
      }
    }
    await this.flushString()
  }

  async cleanup(): Promise<void> {
    await this.string?.handle?.close()
    if (this.string) this.string.handle = undefined
    await this.files?.cleanup()
  }

  scheduleCleanup(): void {
    this.files?.scheduleCleanup()
  }
}

/** Reads xAI input into a small skeleton, never assembling large image strings. */
export async function readExternalImageJson(
  request: Request,
  maxBytes = IMAGE_JSON_MAX_BYTES,
) {
  const reader = new ImageJsonValueReader(true)
  const parser = new StreamingJsonReader()
  let length = 0
  try {
    for await (const chunk of readJsonBytes(
      request.body as ReadableStream<Uint8Array> | null,
      request.signal,
    )) {
      length += chunk.byteLength
      if (length > maxBytes) throw imageJsonLimitError()
      await reader.read(parser.read(chunk))
    }
    await reader.read(parser.read())
    reader.scheduleCleanup()
    return reader
  } catch (error) {
    await reader.cleanup()
    throw error
  }
}

export function assertExternalImageBase64(
  reader: ImageJsonValueReader,
  payload: Record<string, unknown>,
): void {
  const text = JSON.stringify(payload)
  for (const value of reader.external) {
    if (
      text.includes(value.placeholder)
      && value.mode === "compact"
      && !value.prefix.startsWith("data:image/")
      && value.invalidBase64
    )
      throw new SyntaxError("image b64_json is not valid base64")
  }
}

/** Serializes the translated skeleton, expanding only strings retained by xAI. */
export function externalImageJsonStream(
  reader: ImageJsonValueReader,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const template = JSON.stringify(payload)
  const pattern = new RegExp(
    reader.external
      .map((value) =>
        value.placeholder.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
      )
      .join("|"),
    "gu",
  )
  const encode = new TextEncoder()
  let activeStream: ReturnType<typeof createReadStream> | undefined
  async function* serialize(): AsyncGenerator<Uint8Array, void, unknown> {
    try {
      signal.throwIfAborted()
      let offset = 0
      for (const match of reader.external.length ?
        template.matchAll(pattern)
      : []) {
        signal.throwIfAborted()
        yield encode.encode(template.slice(offset, match.index))
        const value = reader.external.find(
          (item) => item.placeholder === match[0],
        )!
        const trim = value.mode !== "identity"
        const stream = createReadStream(value.path, {
          encoding: "utf16le",
          highWaterMark: 64 * 1024,
          start: trim ? value.first * 2 : 0,
          end: trim ? value.end * 2 - 1 : undefined,
        })
        activeStream = stream
        try {
          for await (const chunk of stream) {
            signal.throwIfAborted()
            const text = String(chunk)
            yield encode.encode(
              JSON.stringify(
                value.mode === "compact" ? text.replaceAll(/\s+/gu, "") : text,
              ).slice(1, -1),
            )
          }
        } finally {
          stream.destroy()
          activeStream = undefined
        }
        offset = match.index + match[0].length
      }
      signal.throwIfAborted()
      yield encode.encode(template.slice(offset))
    } catch (error) {
      signal.throwIfAborted()
      throw error
    } finally {
      await reader.cleanup()
    }
  }
  const abort = () => {
    activeStream?.destroy()
    void reader.cleanup().catch(() => {})
  }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  async function* body() {
    try {
      yield* serialize()
    } finally {
      signal.removeEventListener("abort", abort)
    }
  }
  return jsonByteStream(body(), async () => {
    signal.removeEventListener("abort", abort)
    activeStream?.destroy()
    await reader.cleanup()
  })
}
