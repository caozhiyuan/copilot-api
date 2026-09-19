import { createHash } from "node:crypto"

// A new user message changes request IDs, so recovery must be keyed by the
// session, upstream, model and credentials rather than the individual request.
export const buildResponsesRecoveryKey = (
  parts: ReadonlyArray<string>,
): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex")

export const canUseResponsesHttpFallback = (payload: object): boolean =>
  !("previous_response_id" in payload && payload.previous_response_id)

export class ResponsesTransportRecovery {
  private readonly failures = new Map<string, number>()
  private readonly cooldownMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(
    cooldownMs = 300_000,
    maxEntries = 1000,
    now: () => number = Date.now,
  ) {
    this.cooldownMs = cooldownMs
    this.maxEntries = maxEntries
    this.now = now
  }

  shouldUseHttp(key: string): boolean {
    const expiresAt = this.failures.get(key)
    if (expiresAt === undefined) return false
    if (expiresAt <= this.now()) {
      this.failures.delete(key)
      return false
    }
    return true
  }

  recordFailure(key: string): void {
    const now = this.now()
    for (const [entryKey, expiresAt] of this.failures) {
      if (expiresAt <= now) this.failures.delete(entryKey)
    }
    this.failures.delete(key)
    this.failures.set(key, now + this.cooldownMs)
    if (this.failures.size > this.maxEntries) {
      const oldest = this.failures.keys().next().value
      if (oldest !== undefined) this.failures.delete(oldest)
    }
  }
}

export const responsesTransportRecovery = new ResponsesTransportRecovery()
