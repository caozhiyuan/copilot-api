import type { GatewayApiKeyConfig } from "~/lib/types/api-key"
import { describe, expect, test } from "bun:test"
import {
  isApiKeyActive,
  isApiKeyModelAllowed,
  legacyApiKeyId,
  normalizeApiKeyRecord,
  normalizeApiKeyRecords,
} from "~/lib/api-key-config"
import { migrateApiKeyConfig } from "~/lib/config-store"

describe("API key configuration", () => {
  test("migrates old keys once and retains the unused old field", () => {
    const old = { auth: { apiKeys: [" first ", "second", "first"] } }
    const migrated = migrateApiKeyConfig(old)
    expect(migrated.auth?.apiKeys).toEqual(old.auth.apiKeys)
    expect(migrated.auth?.apiKeyConfigs?.map((key) => key.key)).toEqual([
      "first",
      "second",
    ])
    expect(migrated.auth?.apiKeyConfigs?.[0]?.id).toBe(legacyApiKeyId("first"))
    expect(migrateApiKeyConfig(migrated)).toBe(migrated)
    expect(isApiKeyActive(migrated.auth!.apiKeyConfigs![0])).toBe(true)
    expect(
      isApiKeyModelAllowed(
        migrated.auth!.apiKeyConfigs![0],
        "anything",
        "custom",
      ),
    ).toBe(true)
  })
  test("an empty new list never imports or revives old keys", () => {
    const config = { auth: { apiKeys: ["revoked"], apiKeyConfigs: [] } }
    expect(migrateApiKeyConfig(config)).toBe(config)
    expect(normalizeApiKeyRecords(config.auth.apiKeyConfigs)).toEqual([])
    expect(migrateApiKeyConfig({})).toEqual({})
    expect(
      migrateApiKeyConfig({ auth: { adminApiKey: "admin" } }).auth
        ?.apiKeyConfigs,
    ).toBeUndefined()
  })
  test("normalizes policy fields and preserves identity during rotation", () => {
    const input: GatewayApiKeyConfig = {
      id: "stable",
      key: " secret ",
      name: " test ",
      enabled: true,
      expiresAt: "2029-01-01",
      allowedModels: ["codex/*", "codex/*"],
      quota: { period: "month" as const, amount: 100 },
    }
    const key = normalizeApiKeyRecord(input)
    expect(key).toEqual({
      ...input,
      key: "secret",
      name: "test",
      expiresAt: "2029-01-01T00:00:00.000Z",
      allowedModels: ["codex/*"],
    })
    expect(normalizeApiKeyRecord({ ...key, key: "rotated" }).id).toBe("stable")
    expect(normalizeApiKeyRecords([key, key])).toHaveLength(1)
    expect(normalizeApiKeyRecords(undefined)).toEqual([])
    expect(normalizeApiKeyRecords([" ", "key"])).toHaveLength(1)
  })
  test.each([
    null,
    42,
    "",
    {},
    { key: "" },
    { key: "x", id: "invalid id" },
    { key: "x", name: "" },
    { key: "x", enabled: "false" },
    { key: "x", expiresAt: "never" },
    { key: "x", allowedModels: "*" },
    { key: "x", allowedModels: [""] },
    { key: "x", quota: null },
    { key: "x", quota: { period: "hour", amount: 1 } },
    { key: "x", quota: { period: "day", amount: -1 } },
    { key: "x", quota: { period: "day", amount: Infinity } },
    {
      key: "x",
      quota: { period: "day", amount: Number.MAX_SAFE_INTEGER + 1 },
    },
  ])("rejects malformed policy %j", (value) =>
    expect(() => normalizeApiKeyRecord(value)).toThrow(),
  )
  test("rejects malformed collections and duplicate ids", () => {
    expect(() => normalizeApiKeyRecords("key")).toThrow()
    expect(() =>
      normalizeApiKeyRecords([
        { id: "same", key: "a" },
        { id: "same", key: "b" },
      ]),
    ).toThrow()
    expect(() =>
      migrateApiKeyConfig({ auth: { apiKeys: [42 as unknown as string] } }),
    ).toThrow()
  })
  test("enforces enablement, expiration and literal wildcard model rules", () => {
    const base = { id: "key", key: "secret" }
    expect(isApiKeyActive({ ...base, enabled: false })).toBe(false)
    expect(
      isApiKeyActive({ ...base, expiresAt: new Date(100).toISOString() }, 100),
    ).toBe(false)
    expect(
      isApiKeyActive({ ...base, expiresAt: new Date(101).toISOString() }, 100),
    ).toBe(true)
    expect(
      isApiKeyModelAllowed({ ...base, allowedModels: [] }, "gpt-good"),
    ).toBe(false)
    const key = {
      ...base,
      allowedModels: ["codex/gpt-*", "literal.+", "claude-*"],
    }
    expect(isApiKeyModelAllowed(key, "gpt-good", "codex")).toBe(true)
    expect(isApiKeyModelAllowed(key, "gpt-good", "github-copilot")).toBe(false)
    expect(isApiKeyModelAllowed(key, "literal.+")).toBe(true)
    expect(isApiKeyModelAllowed(key, "literalXX")).toBe(false)
    expect(isApiKeyModelAllowed(key, "claude-test")).toBe(true)
    expect(isApiKeyModelAllowed(base, "all")).toBe(true)
  })
})
