export const LOG_BUFFER_MAX_ENTRIES = 2_000
export const LOG_BUFFER_MAX_TEXT_LENGTH = 2 * 1024 * 1024
export const LOG_ENTRY_MAX_TEXT_LENGTH = 32 * 1024
export const LOG_UPDATE_INTERVAL_MS = 50

const LOG_TRUNCATION_MARKER = '\n… [truncated]'

export function truncateLogText(
  input: string,
  maxLength = LOG_ENTRY_MAX_TEXT_LENGTH,
): string {
  if (input.length <= maxLength) return input
  if (maxLength <= 0) return ''

  const tailLength = Math.max(0, maxLength - LOG_TRUNCATION_MARKER.length)
  if (tailLength === 0) {
    let tailStart = input.length - maxLength
    const firstCodeUnit = input.charCodeAt(tailStart)
    if (firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) tailStart += 1
    return input.slice(tailStart)
  }

  let tailStart = input.length - tailLength
  const firstCodeUnit = input.charCodeAt(tailStart)
  if (firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) tailStart += 1
  return LOG_TRUNCATION_MARKER + input.slice(tailStart)
}

interface BoundedLogBufferOptions {
  maxEntries?: number
  maxTextLength?: number
}

export class BoundedLogBuffer<T> {
  private readonly getText: (item: T) => string
  private readonly maxEntries: number
  private readonly maxTextLength: number
  private items: Array<T> = []
  private head = 0
  private textLength = 0

  constructor(
    getText: (item: T) => string,
    options: BoundedLogBufferOptions = {},
  ) {
    this.getText = getText
    this.maxEntries = options.maxEntries ?? LOG_BUFFER_MAX_ENTRIES
    this.maxTextLength = options.maxTextLength ?? LOG_BUFFER_MAX_TEXT_LENGTH
  }

  append(item: T): boolean {
    const itemTextLength = this.getText(item).length
    if (itemTextLength > this.maxTextLength) return false

    while (
      this.head < this.items.length
      && (this.valuesLength() >= this.maxEntries
        || this.textLength + itemTextLength > this.maxTextLength)
    ) {
      this.evictOldest()
    }

    this.items.push(item)
    this.textLength += itemTextLength
    this.compact()
    return true
  }

  clear(): void {
    this.items = []
    this.head = 0
    this.textLength = 0
  }

  values(): Array<T> {
    return this.items.slice(this.head)
  }

  private valuesLength(): number {
    return this.items.length - this.head
  }

  private evictOldest(): void {
    const oldest = this.items[this.head]
    if (oldest !== undefined) this.textLength -= this.getText(oldest).length
    this.head += 1
  }

  private compact(): void {
    if (this.head < 1_024 || this.head * 2 < this.items.length) return
    this.items = this.items.slice(this.head)
    this.head = 0
  }
}
