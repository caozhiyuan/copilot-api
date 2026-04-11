interface SessionOwnershipCacheEntry {
  accountId: string
  expiresAt: number
}

const DEFAULT_MAX_ENTRIES = 10_000
const DEFAULT_TTL_MS = 60 * 60 * 1000

/**
 * In-memory TTL/LRU cache for root-session ownership.
 *
 * Uses Map insertion order for eviction: read/write hits move an entry to the
 * newest position, and writes refresh TTL.
 */
export class SessionOwnershipCache {
  private readonly cache = new Map<string, SessionOwnershipCacheEntry>()
  private readonly maxEntries: number
  private readonly ttlMs: number

  constructor(maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS) {
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
  }

  get(rootSessionId: string): string | undefined {
    const entry = this.cache.get(rootSessionId)
    if (!entry) {
      return undefined
    }

    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(rootSessionId)
      return undefined
    }

    this.cache.delete(rootSessionId)
    this.cache.set(rootSessionId, entry)
    return entry.accountId
  }

  set(rootSessionId: string, accountId: string): void {
    this.cache.delete(rootSessionId)

    while (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next()
      if (oldest.done) {
        break
      }
      this.cache.delete(oldest.value)
    }

    this.cache.set(rootSessionId, {
      accountId,
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  clear(): void {
    this.cache.clear()
  }
}
