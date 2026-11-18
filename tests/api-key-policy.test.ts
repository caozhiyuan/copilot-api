import {
  afterEach,
  beforeEach,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  apiKeyPolicyMiddleware,
  apiKeyPolicyDependencies,
} from "~/lib/api-key-policy"
import type { GatewayApiKeyConfig } from "~/lib/types/api-key"
import { invalidateConfigCache } from "~/lib/config-store"
import { forwardError } from "~/lib/error"
import { PATHS } from "~/lib/paths"
import { requestContext } from "~/lib/request-context"
import { openSqliteDatabase } from "~/lib/sqlite"
import { traceIdMiddleware } from "~/lib/trace"
import { recordTokenUsageEvent } from "~/lib/token-usage"
import {
  closeUsageStore,
  getApiKeyQuotaUsage,
  initializeApiKeyQuotas,
} from "~/lib/token-usage/store"

let home: string
let originalPath: string
let originalDb: string | undefined
beforeEach(async () => {
  await closeUsageStore()
  originalPath = PATHS.CONFIG_PATH
  originalDb = process.env.COPILOT_API_SQLITE_DB_PATH
  home = fs.mkdtempSync(path.join(os.tmpdir(), "api-key-policy-"))
  PATHS.CONFIG_PATH = path.join(home, "config.json")
  process.env.COPILOT_API_SQLITE_DB_PATH = path.join(home, "usage.sqlite")
  fs.writeFileSync(
    PATHS.CONFIG_PATH,
    JSON.stringify({
      auth: { apiKeyConfigs: [] },
      modelMappings: { alias: "custom/permitted" },
      providers: {
        custom: {
          type: "openai-compatible",
          baseUrl: "https://example.com",
          apiKey: "unused",
        },
      },
    }),
  )
  invalidateConfigCache()
  // Other route suites mock configuration exports. Give this middleware its
  // own mapping dependencies while exercising its real HTTP and quota paths.
  spyOn(apiKeyPolicyDependencies, "resolveMappedModel").mockImplementation(
    (model) => (model === "alias" ? "custom/permitted" : model),
  )
  spyOn(apiKeyPolicyDependencies, "getRawProviderConfig").mockImplementation(
    (name) =>
      name === "custom" ?
        {
          type: "openai-compatible",
          baseUrl: "https://example.com",
          apiKey: "unused",
        }
      : null,
  )
})
afterEach(async () => {
  await closeUsageStore().catch(() => {})
  PATHS.CONFIG_PATH = originalPath
  if (originalDb === undefined) delete process.env.COPILOT_API_SQLITE_DB_PATH
  else process.env.COPILOT_API_SQLITE_DB_PATH = originalDb
  invalidateConfigCache()
  mock.restore()
  fs.rmSync(home, { recursive: true, force: true })
})
function app(key?: GatewayApiKeyConfig) {
  const gateway = new Hono()
  gateway.onError((error, c) => forwardError(c, error))
  gateway.use("*", traceIdMiddleware)
  gateway.use("*", async (_c, next) => {
    const context = requestContext.getStore()
    if (context) context.apiKey = key
    await next()
  })
  gateway.use("*", apiKeyPolicyMiddleware)
  for (const endpoint of [
    "/models",
    "/custom/models",
    "/v1/models",
    "/other",
  ]) {
    gateway.get(endpoint, (c) => {
      const shape = c.req.query("shape")
      if (shape === "text") return c.text("plain")
      if (shape === "error") return c.json({ error: "unavailable" }, 503)
      if (shape === "null") return c.json(null)
      if (shape === "other") return c.json({ metadata: true })
      if (shape === "models")
        return c.json({
          models: [{ slug: "custom/permitted" }, { slug: "custom/denied" }],
        })
      const id =
        endpoint === "/custom/models" ? "permitted"
        : c.req.header("user-agent")?.includes("claude") ? "my-claude-alias[1m]"
        : "alias"
      c.header("etag", "original-catalog")
      return c.json({
        data: [{ id }, { id: "denied" }, null, { id: 1 }, false],
        object: "list",
      })
    })
  }
  gateway.post("/responses", (c) => {
    recordTokenUsageEvent({
      source: "provider",
      providerName: "custom",
      endpoint: "responses",
      model: "permitted",
      input_tokens: 1,
      cost: 1,
    })
    return c.json({ ok: true })
  })
  return gateway
}
async function responseJson(
  response: Response | Promise<Response>,
): Promise<unknown> {
  return await (await response).json()
}

test("filters mapped model ids, Claude discovery ids, provider catalogs and Codex slugs", async () => {
  const gateway = app({
    id: "one",
    key: "key",
    allowedModels: ["custom/permitted"],
  })
  const request = async (url: string, headers?: Record<string, string>) => {
    const response = await gateway.request(url, { headers })
    expect(response.headers.get("etag")).toBeNull()
    return await response.json()
  }
  expect(await request("/models")).toEqual({
    data: [{ id: "alias" }],
    object: "list",
  })
  expect(await request("/models", { "user-agent": "claude-code" })).toEqual({
    data: [{ id: "my-claude-alias[1m]" }],
    object: "list",
  })
  expect(await request("/custom/models")).toEqual({
    data: [{ id: "permitted" }],
    object: "list",
  })
  expect(await request("/v1/models?shape=models")).toEqual({
    models: [{ slug: "custom/permitted" }],
  })
  expect(
    await responseJson(
      app({ id: "none", key: "key", allowedModels: [] }).request("/models"),
    ),
  ).toEqual({ data: [], object: "list" })
})
test("leaves unrestricted catalogs, other endpoints and non-catalog responses unchanged", async () => {
  const unrestricted = app()
  expect((await unrestricted.request("/models")).headers.get("etag")).toBe(
    "original-catalog",
  )
  const gateway = app({ id: "one", key: "key", allowedModels: ["custom/*"] })
  expect((await gateway.request("/other")).headers.get("etag")).toBe(
    "original-catalog",
  )
  expect(await (await gateway.request("/models?shape=text")).text()).toBe(
    "plain",
  )
  expect((await gateway.request("/models?shape=error")).status).toBe(503)
  expect(await responseJson(gateway.request("/models?shape=null"))).toBeNull()
  expect(await responseJson(gateway.request("/models?shape=other"))).toEqual({
    metadata: true,
  })
})
test("settles actual tokens before admitting a later request", async () => {
  const gateway = app({
    id: "one",
    key: "key",
    quota: { period: "lifetime", amount: 2 },
  })
  expect((await gateway.request("/responses", { method: "POST" })).status).toBe(
    200,
  )
  expect((await gateway.request("/responses", { method: "POST" })).status).toBe(
    200,
  )
  const exhausted = await gateway.request("/responses", { method: "POST" })
  expect(exhausted.status).toBe(429)
  expect(exhausted.headers.get("Retry-After")).toBeNull()
  expect((await gateway.request("/models")).status).toBe(200)
})
function recordCharge(key: GatewayApiKeyConfig, upstreamRequestId: string) {
  recordTokenUsageEvent({
    source: "provider",
    providerName: "custom",
    endpoint: "responses",
    model: "permitted",
    apiKey: key,
    upstreamRequestId,
    input_tokens: 1,
    cost: 1,
  })
}

test("restores active quotas and reloads a past period if the clock moves back", async () => {
  const key: GatewayApiKeyConfig = {
    id: "one",
    key: "key",
    quota: { period: "day", amount: 2 },
  }
  const monthKey: GatewayApiKeyConfig = {
    ...key,
    quota: { period: "month", amount: 2 },
  }
  const january = new Date(2026, 0, 31, 12)
  const february = new Date(2026, 1, 1, 12)
  try {
    setSystemTime(january)
    recordCharge(key, "january")
    setSystemTime(february)
    recordCharge(key, "february")
    await closeUsageStore()

    expect((await getApiKeyQuotaUsage(key)).usedAmount).toBe(1)
    expect((await getApiKeyQuotaUsage(monthKey)).usedAmount).toBe(1)
    expect(
      (await getApiKeyQuotaUsage({ id: key.id, key: key.key })).usedAmount,
    ).toBe(2)
    setSystemTime(january)
    expect((await getApiKeyQuotaUsage(key)).usedAmount).toBe(1)
    expect((await getApiKeyQuotaUsage(monthKey)).usedAmount).toBe(1)
    setSystemTime(february)
    expect((await getApiKeyQuotaUsage(key)).usedAmount).toBe(1)
  } finally {
    setSystemTime()
  }
})

test("admits requests with available balance while a SQLite write is blocked", async () => {
  const roomy: GatewayApiKeyConfig = {
    id: "roomy",
    key: "roomy",
    quota: { period: "lifetime", amount: 5 },
  }
  const tight: GatewayApiKeyConfig = {
    id: "tight",
    key: "tight",
    quota: { period: "lifetime", amount: 1 },
  }
  await initializeApiKeyQuotas()
  const locker = await openSqliteDatabase(path.join(home, "usage.sqlite"))
  locker.exec("BEGIN IMMEDIATE")
  let locked = true
  const unlock = () => {
    if (!locked) return
    locker.exec("COMMIT")
    locked = false
  }

  recordCharge(roomy, "first")
  recordCharge(tight, "second")
  let tightSettled = false
  const tightResponse = Promise.resolve(
    app(tight).request("/responses", { method: "POST" }),
  ).then((response) => {
    tightSettled = true
    return response
  })
  const fallback = setTimeout(unlock, 1000)
  try {
    await Bun.sleep(30)
    const response = await app(roomy).request("/responses", { method: "POST" })
    expect(response.status).toBe(200)
    expect(locked).toBe(true)
    expect(tightSettled).toBe(false)
  } finally {
    clearTimeout(fallback)
    unlock()
    locker.close?.()
  }
  expect((await tightResponse).status).toBe(429)
  expect((await getApiKeyQuotaUsage(roomy)).usedAmount).toBe(2)
})

test("checks the durable charge when a pending duplicate could exhaust a key", async () => {
  const key: GatewayApiKeyConfig = {
    id: "one",
    key: "key",
    quota: { period: "lifetime", amount: 2 },
  }
  recordCharge(key, "same-request")
  expect((await getApiKeyQuotaUsage(key)).usedAmount).toBe(1)
  recordCharge(key, "same-request")
  const gateway = app(key)
  expect((await gateway.request("/responses", { method: "POST" })).status).toBe(
    200,
  )
  expect((await gateway.request("/responses", { method: "POST" })).status).toBe(
    429,
  )
})

test("returns a reset delay for exhausted calendar quotas", async () => {
  const response = await app({
    id: "one",
    key: "key",
    quota: { period: "day", amount: 0 },
  }).request("/responses", { method: "POST" })
  expect(response.status).toBe(429)
  expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0)
})
test("requires quota persistence only for capped keys", async () => {
  process.env.COPILOT_API_SQLITE_DB_PATH = home
  const response = await app({
    id: "one",
    key: "key",
    quota: { period: "lifetime", amount: 1 },
  }).request("/responses", { method: "POST" })
  expect(response.status).toBe(503)
  const unlimited = await app({ id: "unlimited", key: "key" }).request(
    "/responses",
    { method: "POST" },
  )
  expect(unlimited.status).toBe(200)
})
test("preserves anonymous operation without key quotas", async () => {
  expect((await app().request("/responses", { method: "POST" })).status).toBe(
    200,
  )
})
