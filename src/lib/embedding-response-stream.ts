import { UpstreamResponseSizeLimitExceededError } from "~/lib/error"

const MAX_KEY_BYTES = 128
const MAX_NUMBER_BYTES = 64

type ObjectPhase = "colon" | "key" | "value"
type KeyContext = "root" | "usage"

class EmbeddingUsageParser {
  private depth = 0
  private escaping = false
  private inString = false
  private keyBytes: Array<number> = []
  private keyContext?: KeyContext
  private keyOverflow = false
  private promptNumberBytes?: Array<number>
  private promptNumberOverflow = false
  private promptTokens?: number
  private rootComplete = false
  private rootKey?: string
  private rootPhase: ObjectPhase = "key"
  private rootValueStarted = false
  private usageDepth?: number
  private usageKey?: string
  private usagePhase: ObjectPhase = "key"
  private usageValueStarted = false

  write(chunk: Uint8Array): void {
    for (const byte of chunk) {
      this.writeByte(byte)
    }
  }

  finish(): number | undefined {
    this.finishPromptNumber()
    return this.rootComplete ? this.promptTokens : undefined
  }

  private writeByte(byte: number): void {
    if (this.inString) {
      this.writeStringByte(byte)
      return
    }

    if (this.promptNumberBytes) {
      if (isNumberByte(byte)) {
        this.appendPromptNumberByte(byte)
        return
      }
      this.finishPromptNumber()
    }

    const isWhitespace = isJsonWhitespace(byte)
    const rootValueBeginning =
      this.depth === 1
      && this.rootPhase === "value"
      && !this.rootValueStarted
      && !isWhitespace
    if (rootValueBeginning) {
      this.rootValueStarted = true
    }

    const usageValueBeginning =
      this.usageDepth !== undefined
      && this.depth === this.usageDepth
      && this.usagePhase === "value"
      && !this.usageValueStarted
      && !isWhitespace
    if (usageValueBeginning) {
      this.usageValueStarted = true
      if (this.usageKey === "prompt_tokens") {
        this.promptTokens = undefined
        if (isNumberStartByte(byte)) {
          this.promptNumberBytes = [byte]
          this.promptNumberOverflow = false
          return
        }
      }
    }

    if (byte === 0x22) {
      this.startString()
      return
    }

    if (byte === 0x7b || byte === 0x5b) {
      if (byte === 0x7b && this.depth === 0) {
        this.rootPhase = "key"
        this.rootValueStarted = false
      }
      const startsUsage =
        byte === 0x7b && rootValueBeginning && this.rootKey === "usage"
      this.depth += 1
      if (startsUsage) {
        this.usageDepth = this.depth
        this.usageKey = undefined
        this.usagePhase = "key"
        this.usageValueStarted = false
      }
      return
    }

    if (byte === 0x7d || byte === 0x5d) {
      if (byte === 0x7d && this.depth === this.usageDepth) {
        this.usageDepth = undefined
        this.usageKey = undefined
      }
      if (byte === 0x7d && this.depth === 1) {
        this.rootComplete = true
      }
      this.depth = Math.max(0, this.depth - 1)
      return
    }

    if (byte === 0x3a) {
      if (this.depth === 1 && this.rootPhase === "colon") {
        this.rootPhase = "value"
        this.rootValueStarted = false
      } else if (
        this.usageDepth !== undefined
        && this.depth === this.usageDepth
        && this.usagePhase === "colon"
      ) {
        this.usagePhase = "value"
        this.usageValueStarted = false
      }
      return
    }

    if (byte === 0x2c) {
      if (this.usageDepth !== undefined && this.depth === this.usageDepth) {
        this.usageKey = undefined
        this.usagePhase = "key"
        this.usageValueStarted = false
      } else if (this.depth === 1) {
        this.rootKey = undefined
        this.rootPhase = "key"
        this.rootValueStarted = false
      }
    }
  }

  private startString(): void {
    this.inString = true
    this.escaping = false
    this.keyBytes = []
    this.keyOverflow = false
    this.keyContext =
      this.depth === 1 && this.rootPhase === "key" ? "root"
      : (
        this.usageDepth !== undefined
        && this.depth === this.usageDepth
        && this.usagePhase === "key"
      ) ?
        "usage"
      : undefined
  }

  private writeStringByte(byte: number): void {
    if (this.escaping) {
      this.appendKeyByte(byte)
      this.escaping = false
      return
    }

    if (byte === 0x5c) {
      this.appendKeyByte(byte)
      this.escaping = true
      return
    }

    if (byte !== 0x22) {
      this.appendKeyByte(byte)
      return
    }

    this.inString = false
    const key = this.decodeKey()
    if (this.keyContext === "root") {
      this.rootKey = key
      this.rootPhase = "colon"
    } else if (this.keyContext === "usage") {
      this.usageKey = key
      this.usagePhase = "colon"
    }
    this.keyContext = undefined
  }

  private appendKeyByte(byte: number): void {
    if (!this.keyContext || this.keyOverflow) return
    if (this.keyBytes.length >= MAX_KEY_BYTES) {
      this.keyBytes = []
      this.keyOverflow = true
      return
    }
    this.keyBytes.push(byte)
  }

  private decodeKey(): string | undefined {
    if (!this.keyContext || this.keyOverflow) return undefined
    try {
      const encodedKey = new TextDecoder().decode(new Uint8Array(this.keyBytes))
      return JSON.parse(`"${encodedKey}"`) as string
    } catch {
      return undefined
    }
  }

  private appendPromptNumberByte(byte: number): void {
    if (this.promptNumberOverflow || !this.promptNumberBytes) return
    if (this.promptNumberBytes.length >= MAX_NUMBER_BYTES) {
      this.promptNumberBytes = []
      this.promptNumberOverflow = true
      return
    }
    this.promptNumberBytes.push(byte)
  }

  private finishPromptNumber(): void {
    if (!this.promptNumberBytes) return
    if (!this.promptNumberOverflow) {
      try {
        const encodedNumber = new TextDecoder().decode(
          new Uint8Array(this.promptNumberBytes),
        )
        const parsedNumber = JSON.parse(encodedNumber) as unknown
        this.promptTokens =
          typeof parsedNumber === "number" && Number.isFinite(parsedNumber) ?
            parsedNumber
          : undefined
      } catch {
        this.promptTokens = undefined
      }
    }
    this.promptNumberBytes = undefined
    this.promptNumberOverflow = false
  }
}

export function streamEmbeddingResponseBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onPromptTokens: (promptTokens: number) => void,
): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer")
  }

  const usageParser = new EmbeddingUsageParser()
  let streamedBytes = 0
  const source =
    body
    ?? new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
  const reader = source.getReader()
  let released = false
  const releaseReader = () => {
    if (released) return
    released = true
    reader.releaseLock()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          const promptTokens = usageParser.finish()
          if (promptTokens !== undefined) {
            onPromptTokens(promptTokens)
          }
          releaseReader()
          controller.close()
          return
        }

        streamedBytes += value.byteLength
        if (streamedBytes > maxBytes) {
          const error = new UpstreamResponseSizeLimitExceededError(maxBytes)
          await reader.cancel(error).catch(() => {})
          releaseReader()
          controller.error(error)
          return
        }
        usageParser.write(value)
        controller.enqueue(value)
      } catch (error) {
        await reader.cancel(error).catch(() => {})
        releaseReader()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        releaseReader()
      }
    },
  })
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

function isNumberStartByte(byte: number): boolean {
  return byte === 0x2d || (byte >= 0x30 && byte <= 0x39)
}

function isNumberByte(byte: number): boolean {
  return (
    isNumberStartByte(byte)
    || byte === 0x2b
    || byte === 0x2e
    || byte === 0x45
    || byte === 0x65
  )
}
