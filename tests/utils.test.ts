import type { Context } from "hono"

import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"

import { requestContext } from "~/lib/request-context"

import {
  getPromptCacheKey,
  getRootSessionId,
  getRootSessionIdFromHeaders,
  getSessionAffinityFromHeaders,
  getUUID,
} from "~/lib/utils"

const getLegacyUUID = (content: string): string => {
  const hash32 = createHash("sha256").update(content).digest("hex").slice(0, 32)
  return `${hash32.slice(0, 8)}-${hash32.slice(8, 12)}-${hash32.slice(12, 16)}-${hash32.slice(16, 20)}-${hash32.slice(20)}`
}

test("getUUID returns a deterministic standards-compliant UUIDv4", () => {
  const uuid = getUUID("hello world")

  expect(uuid).toBe("b94d27b9-934d-4e08-a52e-52d7da7dabfa")
  expect(uuid).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  expect(getUUID("hello world")).toBe(uuid)
  expect(getUUID("hello world!")).not.toBe(uuid)
})

test("prints randomUUID and deterministic UUID for comparison", () => {
  const input = "hello world"
  const random = randomUUID()
  const legacy = getLegacyUUID(input)
  const derived = getUUID(input)
  const derivedAgain = getUUID(input)

  console.info(`randomUUID(): ${random}`)
  console.info(`legacy getUUID(${JSON.stringify(input)}): ${legacy}`)
  console.info(`getUUID(${JSON.stringify(input)}): ${derived}`)
  console.info(`getUUID(${JSON.stringify(input)}) again: ${derivedAgain}`)

  expect(random).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  expect(derived).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  expect(legacy).toBe("b94d27b9-934d-3e08-a52e-52d7da7dabfa")
  expect(derived).toBe("b94d27b9-934d-4e08-a52e-52d7da7dabfa")
  expect(derivedAgain).toBe(derived)
  expect(legacy).not.toBe(derived)
  expect(random).not.toBe(derived)
})

const headerDerivationCases: Array<{
  headers: Record<string, string>
  expected?: string
}> = [
  {
    headers: {
      "x-claude-code-session-id": " claude-root ",
      "session-id": "other",
    },
    expected: "claude-root",
  },
  {
    headers: { "x-claude-code-session-id": " ", "session-id": "legacy" },
    expected: "legacy",
  },
  {
    headers: {
      "session-id": " session-1 ",
      "x-root-session-id": "root-1",
      "x-session-id": "leaf-1",
    },
    expected: "session-1",
  },
  {
    headers: { "session-id": " ", "x-root-session-id": " root-1 " },
    expected: "root-1",
  },
  { headers: { "x-session-id": "leaf-1" }, expected: "leaf-1" },
  { headers: {}, expected: undefined },
]

test.each(headerDerivationCases)(
  "getRootSessionIdFromHeaders resolves $expected",
  ({ headers, expected }) => {
    const context = {
      req: {
        header: (name: string) => new Headers(headers).get(name) ?? undefined,
      },
    } as unknown as Context

    expect(getRootSessionIdFromHeaders(context)).toBe(expected)
  },
)

test.each([
  {
    headers: {
      "x-opencode-session-id": " opencode-1 ",
      "x-session-affinity": "affinity-1",
      "x-client-request-id": "client-1",
      "thread-id": "thread-1",
    },
    expected: "opencode-1",
  },
  {
    headers: {
      "x-opencode-session-id": " ",
      "x-session-affinity": "affinity-1",
      "x-client-request-id": "client-1",
      "thread-id": "thread-1",
    },
    expected: "affinity-1",
  },
  {
    headers: {
      "x-session-affinity": " ",
      "x-client-request-id": "client-1",
      "thread-id": "thread-1",
    },
    expected: "client-1",
  },
  { headers: { "thread-id": " thread-1 " }, expected: "thread-1" },
  { headers: { "thread-id": " " }, expected: undefined },
  {
    headers: { "x-parent-session-id": "root", "x-session-id": "child" },
    expected: undefined,
  },
  { headers: {}, expected: undefined },
] as Array<{ headers: Record<string, string>; expected?: string }>)(
  "getSessionAffinityFromHeaders resolves $expected",
  ({ headers, expected }) => {
    const context = {
      req: {
        header: (name: string) => new Headers(headers).get(name) ?? undefined,
      },
    } as unknown as Context

    expect(getSessionAffinityFromHeaders(context)).toBe(expected)
  },
)

test.each([
  { rootSessionId: "root", sessionAffinity: "child", expected: "root" },
  { rootSessionId: " root ", sessionAffinity: undefined, expected: "root" },
  { rootSessionId: " ", sessionAffinity: " child ", expected: "child" },
  { rootSessionId: undefined, sessionAffinity: "child", expected: "child" },
  { rootSessionId: undefined, sessionAffinity: undefined, expected: null },
])("uses trace sessions for interaction IDs and cache keys (%#)", (context) => {
  requestContext.run(
    {
      ...context,
      parentSessionId: "unrelated-parent",
      traceId: "test-trace",
      startTime: Date.now(),
      userAgent: "test",
    },
    () => {
      expect(getPromptCacheKey()).toBe(context.expected)
      expect(getRootSessionId()).toBe(
        context.expected ? getUUID(context.expected) : undefined,
      )
    },
  )
})

test("has no interaction ID or cache key outside a trace session", () => {
  expect(getRootSessionId()).toBeUndefined()
  expect(getPromptCacheKey()).toBeNull()
})
