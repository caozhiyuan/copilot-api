import { expect, test } from "bun:test"

import { SessionOwnershipCache } from "../src/lib/session-ownership"

test("get returns undefined for missing key", () => {
  const cache = new SessionOwnershipCache()

  expect(cache.get("unknown")).toBeUndefined()
})

test("set then get returns stored accountId", () => {
  const cache = new SessionOwnershipCache()

  cache.set("root-session-1", "account-1")

  expect(cache.get("root-session-1")).toBe("account-1")
})

test("clear removes all entries", () => {
  const cache = new SessionOwnershipCache()

  cache.set("root-session-1", "account-1")
  cache.set("root-session-2", "account-2")
  cache.clear()

  expect(cache.get("root-session-1")).toBeUndefined()
  expect(cache.get("root-session-2")).toBeUndefined()
})

test("LRU eviction removes oldest entry when at capacity", () => {
  const cache = new SessionOwnershipCache(2)

  cache.set("root-session-1", "account-1")
  cache.set("root-session-2", "account-2")
  cache.set("root-session-3", "account-3")

  expect(cache.get("root-session-1")).toBeUndefined()
  expect(cache.get("root-session-2")).toBe("account-2")
  expect(cache.get("root-session-3")).toBe("account-3")
})
