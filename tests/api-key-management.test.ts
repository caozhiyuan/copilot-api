import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

test("enforces key policies, isolates usage, restores quotas and ignores retained old keys", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-key-management-"))
  try {
    const config = {
      auth: {
        isolateApiKeyUsage: true,
        apiKeys: ["old-a", "legacy-only"],
        apiKeyConfigs: [
          {
            id: "a",
            key: "old-a",
            name: "Alice",
            allowedModels: ["codex/gpt-good"],
            quota: { period: "lifetime", amount: 10 },
          },
          {
            id: "b",
            key: "key-b",
            name: "Bob",
            quota: { period: "month", amount: 100 },
          },
          { id: "off", key: "disabled", enabled: false },
          { id: "expired", key: "expired", expiresAt: "2000-01-01T00:00:00Z" },
        ],
        adminApiKey: "admin",
      },
      providers: {
        codex: {
          type: "openai-responses",
          baseUrl: "https://example.com",
          apiKey: "unused",
          pricingCurrency: "USD",
          models: { "gpt-good": { pricing: { input: 1, output: 2 } } },
        },
      },
      modelMappings: { alias: "codex/gpt-good" },
    }
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config))
    const script = [
      'import { Hono } from "hono"',
      'import { traceIdMiddleware } from "./src/lib/trace.ts"',
      'import { createAuthMiddleware, getConfiguredAdminApiKeys } from "./src/lib/request-auth.ts"',
      'import { apiKeyPolicyMiddleware } from "./src/lib/api-key-policy.ts"',
      'import { requestContext, setPluginRequestActualModel } from "./src/lib/request-context.ts"',
      'import { forwardError } from "./src/lib/error.ts"',
      'import { resolveMappedModel, upsertConfiguredApiKey, removeConfiguredApiKey, getConfig } from "./src/lib/config.ts"',
      'import { recordTokenUsageEvent, closeUsageStore } from "./src/lib/token-usage/index.ts"',
      'import { getApiKeyQuotaUsage, pruneTokenUsageEvents } from "./src/lib/token-usage/store.ts"',
      'import { tokenUsageRoute } from "./src/routes/token-usage/route.ts"',
      "const app = new Hono()",
      "app.onError((error, c) => forwardError(c, error))",
      'app.use("*", traceIdMiddleware)',
      'app.use("*", createAuthMiddleware({ allowUnauthenticatedPaths: [], shouldSkipPath: (path) => path.startsWith("/admin/") }))',
      'app.use("/admin/*", createAuthMiddleware({ getApiKeys: getConfiguredAdminApiKeys, allowWhenNoApiKeys: false, allowUnauthenticatedPaths: [] }))',
      'app.use("*", apiKeyPolicyMiddleware)',
      'app.get("/models", (c) => c.json({ data: [{ id: "alias" }, { id: "forbidden" }], object: "list" }))',
      'app.post("/responses", async (c) => {',
      '  const payload = await c.req.json(); const target = resolveMappedModel(payload.model); const parts = target.split("/");',
      '  setPluginRequestActualModel(parts.slice(1).join("/"), parts[0]);',
      '  const usage = { source: "provider", providerName: "codex", endpoint: "responses", model: parts.slice(1).join("/"), input_tokens: payload.tokens ?? 10, cost: payload.tokens ?? 10, upstreamRequestId: "up-" + requestContext.getStore().traceId };',
      "  recordTokenUsageEvent(usage); recordTokenUsageEvent(usage);",
      "  return c.json({ ok: true });",
      "})",
      'app.route("/token-usage", tokenUsageRoute); app.route("/admin/token-usage", tokenUsageRoute)',
      'app.get("/usage/:provider", (c) => c.json({ available: true }))',
      'app.get("/usage", (c) => c.json({ available: true }))',
      'const call = (key, url, payload) => app.request(url, { headers: { "x-api-key": key, ...(payload ? { "content-type": "application/json" } : {}) }, ...(payload ? { method: "POST", body: JSON.stringify(payload) } : {}) })',
      "const result = {}",
      'result.disabled = (await call("disabled", "/models")).status',
      'result.expired = (await call("expired", "/models")).status',
      'result.legacy = (await call("legacy-only", "/models")).status',
      'result.forbidden = (await call("old-a", "/responses", { model: "codex/not-allowed" })).status',
      'result.models = await (await call("old-a", "/models")).json()',
      'result.unpriced = (await call("key-b", "/responses", { model: "codex/no-price" })).status',
      'result.allowed = (await call("old-a", "/responses", { model: "alias" })).status',
      'result.exhausted = (await call("old-a", "/responses", { model: "alias" })).status',
      'result.other = (await call("key-b", "/responses", { model: "codex/gpt-good", tokens: 5 })).status',
      'recordTokenUsageEvent({ source: "provider", providerName: "codex", endpoint: "responses", model: "gpt-good", input_tokens: 2, traceId: "old-history" })',
      'result.own = await (await call("old-a", "/token-usage?period=lifetime&api_key_id=b")).json()',
      'result.events = await (await call("old-a", "/token-usage/events?period=lifetime")).json()',
      'result.daily = await (await call("old-a", "/token-usage/daily?period=lifetime")).json()',
      'result.sessions = await (await call("old-a", "/token-usage/sessions?period=lifetime")).json()',
      'result.global = await (await call("admin", "/admin/token-usage?period=lifetime")).json()',
      'result.unattributed = await (await call("admin", "/admin/token-usage?period=lifetime&api_key_id=__unattributed__")).json()',
      'result.adminFiltered = await (await call("admin", "/admin/token-usage?period=lifetime&api_key_id=b")).json()',
      'result.isolatedSubscriptions = (await call("old-a", "/usage/codex")).status',
      'result.isolatedLegacyUsage = (await call("old-a", "/usage")).status',
      'result.isolatedHeader = (await call("old-a", "/token-usage")).headers.get("X-API-Key-Usage-Isolated")',
      "delete getConfig().auth.isolateApiKeyUsage",
      'result.shared = await (await call("old-a", "/token-usage?period=lifetime&api_key_id=b")).json()',
      'result.sharedDaily = await (await call("old-a", "/token-usage/daily?period=lifetime")).json()',
      'result.sharedEvents = await (await call("old-a", "/token-usage/events?period=lifetime")).json()',
      'result.sharedSessions = await (await call("old-a", "/token-usage/sessions?period=lifetime")).json()',
      'result.sharedSubscriptions = (await call("old-a", "/usage/codex")).status',
      'result.sharedHeader = (await call("old-a", "/token-usage")).headers.get("X-API-Key-Usage-Isolated")',
      "getConfig().auth.isolateApiKeyUsage = false",
      'result.sharedExplicit = await (await call("old-a", "/token-usage?period=lifetime")).json()',
      "getConfig().auth.isolateApiKeyUsage = true",
      'const key = getConfig().auth.apiKeyConfigs.find((key) => key.id === "a")',
      "result.live = await getApiKeyQuotaUsage(key)",
      "await closeUsageStore()",
      "result.restored = await getApiKeyQuotaUsage(key)",
      "await pruneTokenUsageEvents({ nowMs: Date.now() + 3 * 86400000, retentionDays: 1 })",
      "await closeUsageStore()",
      "result.afterCleanup = await getApiKeyQuotaUsage(key)",
      'upsertConfiguredApiKey({ ...key, key: "rotated-a", name: "Renamed" })',
      'result.rotatedOld = (await call("old-a", "/models")).status',
      'result.rotatedNew = (await call("rotated-a", "/models")).status',
      'result.rotatedQuota = await getApiKeyQuotaUsage({ ...key, key: "rotated-a" })',
      'removeConfiguredApiKey("a")',
      'result.deleted = (await call("rotated-a", "/models")).status',
      "result.oldField = getConfig().auth.apiKeys",
      'result.legacyAfterDelete = (await call("old-a", "/models")).status',
      "await closeUsageStore()",
      'console.log("RESULT " + JSON.stringify(result))',
    ].join("\n")
    const child = Bun.spawnSync({
      cmd: [process.execPath, "--eval", script],
      cwd: path.join(import.meta.dir, ".."),
      env: {
        ...process.env,
        COPILOT_API_HOME: home,
        COPILOT_API_SQLITE_DB_PATH: path.join(home, "usage.sqlite"),
        COPILOT_API_OAUTH_APP: "",
        COPILOT_API_ENTERPRISE_URL: "",
      },
    })
    const stdout = new TextDecoder().decode(child.stdout)
    const stderr = new TextDecoder().decode(child.stderr)
    if (child.exitCode !== 0) throw new Error(stdout + "\n" + stderr)
    const line = stdout.split("\n").find((line) => line.startsWith("RESULT "))
    if (!line) throw new Error(stdout + "\n" + stderr)
    const result = JSON.parse(line.slice(7)) as {
      disabled: number
      expired: number
      legacy: number
      forbidden: number
      unpriced: number
      allowed: number
      exhausted: number
      other: number
      models: { data: Array<{ id: string }> }
      own: { totals: { total_tokens: number; request_count: number } }
      events: {
        items: Array<{
          api_key_id: string
          api_key_name: string
          user_id: string
        }>
      }
      daily: { totals: { total_tokens: number } }
      sessions: { items: Array<{ total_tokens: number }> }
      global: { totals: { total_tokens: number } }
      unattributed: { totals: { total_tokens: number } }
      adminFiltered: { totals: { total_tokens: number } }
      isolatedSubscriptions: number
      isolatedLegacyUsage: number
      isolatedHeader: string
      shared: { totals: { total_tokens: number } }
      sharedDaily: { totals: { total_tokens: number } }
      sharedEvents: { items: Array<{ api_key_id: string | null }> }
      sharedSessions: { items: Array<{ total_tokens: number }> }
      sharedSubscriptions: number
      sharedHeader: string
      sharedExplicit: { totals: { total_tokens: number } }
      live: { usedAmount: number; remainingAmount: number }
      restored: { usedAmount: number }
      afterCleanup: { usedAmount: number }
      rotatedOld: number
      rotatedNew: number
      deleted: number
      legacyAfterDelete: number
      rotatedQuota: { usedAmount: number }
      oldField: Array<string>
    }
    expect([result.disabled, result.expired, result.legacy]).toEqual([
      401, 401, 401,
    ])
    expect(result.forbidden).toBe(403)
    expect(result.unpriced).toBe(403)
    expect(result.models.data).toEqual([{ id: "alias" }])
    expect([result.allowed, result.exhausted, result.other]).toEqual([
      200, 429, 200,
    ])
    expect(result.own.totals.total_tokens).toBe(10)
    expect(result.own.totals.request_count).toBe(1)
    expect(result.events.items[0]).toMatchObject({
      api_key_id: "a",
      api_key_name: "Alice",
      user_id: "codex",
    })
    expect(result.daily.totals.total_tokens).toBe(10)
    expect(result.sessions.items[0]?.total_tokens).toBe(10)
    expect(result.global.totals.total_tokens).toBe(17)
    expect(result.unattributed.totals.total_tokens).toBe(2)
    expect(result.adminFiltered.totals.total_tokens).toBe(5)
    expect(result.isolatedSubscriptions).toBe(403)
    expect(result.isolatedLegacyUsage).toBe(403)
    expect(result.isolatedHeader).toBe("true")
    expect(result.shared.totals.total_tokens).toBe(17)
    expect(result.sharedDaily.totals.total_tokens).toBe(17)
    expect(
      result.sharedEvents.items.map((item) => item.api_key_id).sort(),
    ).toEqual(["a", "b", null].sort())
    expect(
      result.sharedSessions.items.reduce(
        (total, item) => total + item.total_tokens,
        0,
      ),
    ).toBe(17)
    expect(result.sharedSubscriptions).toBe(200)
    expect(result.sharedHeader).toBe("false")
    expect(result.sharedExplicit.totals.total_tokens).toBe(17)
    expect(result.live).toMatchObject({ usedAmount: 10, remainingAmount: 0 })
    expect(result.restored.usedAmount).toBe(10)
    expect(result.afterCleanup.usedAmount).toBe(10)
    expect([
      result.rotatedOld,
      result.rotatedNew,
      result.deleted,
      result.legacyAfterDelete,
    ]).toEqual([401, 200, 401, 401])
    expect(result.rotatedQuota.usedAmount).toBe(10)
    expect(result.oldField).toEqual(["old-a", "legacy-only"])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
