const MAX_METADATA_LENGTH = 64 * 1024
const OMITTED_FIELDS = new Set(["data", "b64_json", "partial_image_b64"])

/** Reads JSON/SSE object metadata without retaining image payloads. */
export class ImageJsonMetadataReader {
  private depth = 0
  private inString = false
  private escaped = false
  private phase: "key" | "colon" | "value" = "key"
  private keyText = ""
  private key = ""
  private value: string | null = null
  private fields = new Map<string, unknown>()
  private metadataLength = 0
  private readonly onMetadata: (metadata: Record<string, unknown>) => void

  constructor(onMetadata: (metadata: Record<string, unknown>) => void) {
    this.onMetadata = onMetadata
  }

  write(text: string): void {
    for (const char of text) this.readCharacter(char)
  }

  private readCharacter(char: string): void {
    if (this.depth === 0) {
      if (char === "{") {
        this.depth = 1
        this.phase = "key"
        this.fields.clear()
        this.metadataLength = 0
      }
      return
    }

    if (!this.inString && this.depth === 1) {
      if (char === "}") {
        if (this.phase === "value") this.finishField()
        this.depth = 0
        this.onMetadata(Object.fromEntries(this.fields))
        return
      }
      if (this.phase === "key" && char === '"') {
        this.keyText = '"'
        this.phase = "colon"
        this.inString = true
        return
      }
      if (this.phase === "colon" && char === ":") {
        try {
          this.key = JSON.parse(this.keyText) as string
        } catch {
          this.key = ""
        }
        this.value = OMITTED_FIELDS.has(this.key) ? null : ""
        this.phase = "value"
        return
      }
      if (this.phase === "value" && char === ",") {
        this.finishField()
        this.phase = "key"
        return
      }
    }

    if (this.phase === "colon" && this.keyText.length < MAX_METADATA_LENGTH) {
      this.keyText += char
    } else if (this.phase === "value" && this.value !== null) {
      if (this.metadataLength + this.value.length < MAX_METADATA_LENGTH) {
        this.value += char
      } else {
        this.value = null
      }
    }

    if (this.inString) {
      if (this.escaped) this.escaped = false
      else if (char === "\\") this.escaped = true
      else if (char === '"') this.inString = false
    } else if (char === '"') {
      this.inString = true
    } else if (char === "{" || char === "[") {
      this.depth++
    } else if (char === "}" || char === "]") {
      this.depth--
    }
  }

  private finishField(): void {
    if (this.value === null) return
    try {
      const value: unknown = JSON.parse(this.value)
      this.fields.set(this.key, value)
      this.metadataLength += this.key.length + this.value.length
    } catch {
      // Malformed or oversized metadata must not interrupt image forwarding.
    }
    this.value = null
  }
}
