import type { AccountRuntime } from "~/lib/types/account"

export interface AffinityContext {
  promptCacheKey?: string
  sessionId?: string
  safetyIdentifier?: string
}

interface AffinityCacheEntry {
  accountId: string
  expiresAt: number
}

const DEFAULT_MAX_ENTRIES = 10_000
const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * In-memory LRU cache with TTL for account affinity mappings.
 *
 * Uses Map insertion order for LRU eviction: accessed/updated entries are
 * deleted and re-inserted so they move to the "newest" end.
 */
export class AccountAffinityCache {
  private readonly cache = new Map<string, AffinityCacheEntry>()
  private readonly maxEntries: number
  private readonly ttlMs: number

  constructor(maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS) {
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
  }

  /** Look up the preferred account ID for a cache key. Returns undefined if not found or expired. */
  get(key: string): string | undefined {
    const entry = this.cache.get(key)
    if (!entry) {
      return undefined
    }

    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key)
      return undefined
    }

    return entry.accountId
  }

  /** Record a successful account mapping. Refreshes TTL and moves the entry to the newest position. */
  set(key: string, accountId: string): void {
    // Delete first so re-insertion moves it to the newest position (LRU).
    this.cache.delete(key)

    // Evict oldest entries if at capacity.
    while (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      this.cache.delete(oldest.value)
    }

    this.cache.set(key, {
      accountId,
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  /** Remove a specific entry. */
  delete(key: string): boolean {
    return this.cache.delete(key)
  }

  /** Remove all entries. */
  clear(): void {
    this.cache.clear()
  }

  /** Current number of entries (including potentially expired ones). */
  get size(): number {
    return this.cache.size
  }
}

/**
 * Extract the best available affinity key from the request context.
 * Priority: promptCacheKey > sessionId > safetyIdentifier.
 */
export function extractAffinityKey(
  context: AffinityContext,
): string | undefined {
  for (const candidate of [
    context.promptCacheKey,
    context.sessionId,
    context.safetyIdentifier,
  ]) {
    const normalized = candidate?.trim()
    if (normalized) return normalized
  }
  return undefined
}

/**
 * Build the full cache key by combining the affinity key with the model ID.
 * This prevents cross-model pollution (same session requesting different models
 * can be routed to different accounts).
 */
export function buildAffinityCacheKey(
  affinityKey: string,
  modelId: string,
): string {
  return `${affinityKey}:${modelId}`
}

/**
 * Check whether an account is a valid affinity candidate.
 * An account is valid if it is not failed and is present in the provided
 * runtime list.
 */
export function isAffinityAccountUsable(
  accountId: string,
  accounts: ReadonlyArray<AccountRuntime>,
): AccountRuntime | undefined {
  const account = accounts.find((a) => a.id === accountId)
  if (!account) return undefined
  if (account.failed) return undefined
  return account
}
