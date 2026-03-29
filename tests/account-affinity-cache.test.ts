import { expect, test } from "bun:test"

import type { AccountRuntime } from "../src/lib/types/account"

import {
  AccountAffinityCache,
  buildAffinityCacheKey,
  extractAffinityKey,
  isAffinityAccountUsable,
} from "../src/lib/account-affinity"

// ---------------------------------------------------------------------------
// AccountAffinityCache
// ---------------------------------------------------------------------------

test("get returns undefined for missing key", () => {
  const cache = new AccountAffinityCache()
  expect(cache.get("unknown")).toBeUndefined()
})

test("set then get returns stored accountId", () => {
  const cache = new AccountAffinityCache()
  cache.set("session:model-a", "account-1")
  expect(cache.get("session:model-a")).toBe("account-1")
})

test("set overwrites existing entry", () => {
  const cache = new AccountAffinityCache()
  cache.set("k", "old")
  cache.set("k", "new")
  expect(cache.get("k")).toBe("new")
  expect(cache.size).toBe(1)
})

test("delete removes entry", () => {
  const cache = new AccountAffinityCache()
  cache.set("k", "v")
  expect(cache.delete("k")).toBe(true)
  expect(cache.get("k")).toBeUndefined()
  expect(cache.size).toBe(0)
})

test("delete returns false for missing key", () => {
  const cache = new AccountAffinityCache()
  expect(cache.delete("nope")).toBe(false)
})

test("clear removes all entries", () => {
  const cache = new AccountAffinityCache()
  cache.set("a", "1")
  cache.set("b", "2")
  cache.clear()
  expect(cache.size).toBe(0)
  expect(cache.get("a")).toBeUndefined()
})

test("expired entry is not returned by get", () => {
  // TTL = 1ms
  const cache = new AccountAffinityCache(100, 1)
  cache.set("k", "v")

  // Force expiration by manipulating time internally is tricky with bun:test,
  // so we use a very short TTL and a synchronous busy-wait.
  const start = Date.now()
  while (Date.now() - start < 5) {
    // busy-wait 5ms to ensure 1ms TTL expires
  }

  expect(cache.get("k")).toBeUndefined()
  // Entry should have been cleaned up on access
  expect(cache.size).toBe(0)
})

test("LRU eviction removes oldest entry when at capacity", () => {
  const cache = new AccountAffinityCache(3)
  cache.set("a", "1")
  cache.set("b", "2")
  cache.set("c", "3")

  // Cache is full. Adding "d" should evict "a" (oldest).
  cache.set("d", "4")

  expect(cache.size).toBe(3)
  expect(cache.get("a")).toBeUndefined()
  expect(cache.get("b")).toBe("2")
  expect(cache.get("c")).toBe("3")
  expect(cache.get("d")).toBe("4")
})

test("set refreshes position so entry is not evicted prematurely", () => {
  const cache = new AccountAffinityCache(3)
  cache.set("a", "1")
  cache.set("b", "2")
  cache.set("c", "3")

  // Re-set "a" — it should move to the newest position.
  cache.set("a", "1-updated")

  // Adding "d" should now evict "b" (the oldest after "a" was refreshed).
  cache.set("d", "4")

  expect(cache.size).toBe(3)
  expect(cache.get("a")).toBe("1-updated")
  expect(cache.get("b")).toBeUndefined()
  expect(cache.get("c")).toBe("3")
  expect(cache.get("d")).toBe("4")
})

test("size reflects current entry count", () => {
  const cache = new AccountAffinityCache()
  expect(cache.size).toBe(0)
  cache.set("a", "1")
  expect(cache.size).toBe(1)
  cache.set("b", "2")
  expect(cache.size).toBe(2)
  cache.delete("a")
  expect(cache.size).toBe(1)
})

// ---------------------------------------------------------------------------
// extractAffinityKey
// ---------------------------------------------------------------------------

test("extractAffinityKey returns requestId", () => {
  expect(
    extractAffinityKey({
      requestId: "req-123",
    }),
  ).toBe("req-123")
})

test("extractAffinityKey returns undefined when requestId is empty", () => {
  expect(
    extractAffinityKey({
      requestId: "  ",
    }),
  ).toBeUndefined()
})

test("extractAffinityKey returns undefined when requestId is missing", () => {
  expect(extractAffinityKey({})).toBeUndefined()
})

// ---------------------------------------------------------------------------
// buildAffinityCacheKey
// ---------------------------------------------------------------------------

test("buildAffinityCacheKey combines key and model", () => {
  expect(buildAffinityCacheKey("session-abc", "gpt-5")).toBe(
    "session-abc:gpt-5",
  )
})

// ---------------------------------------------------------------------------
// isAffinityAccountUsable
// ---------------------------------------------------------------------------

test("isAffinityAccountUsable returns account when valid", () => {
  const account: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
  }
  expect(isAffinityAccountUsable("a", [account])).toBe(account)
})

test("isAffinityAccountUsable returns undefined for missing account", () => {
  expect(isAffinityAccountUsable("missing", [])).toBeUndefined()
})

test("isAffinityAccountUsable returns undefined for failed account", () => {
  const account: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    failed: true,
    failureReason: "test",
  }
  expect(isAffinityAccountUsable("a", [account])).toBeUndefined()
})
