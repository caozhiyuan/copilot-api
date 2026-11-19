import { beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"

import { createAuthMiddleware, getIsolatedApiKeyId } from "~/lib/request-auth"
import { apiKeyPolicyMiddleware } from "~/lib/api-key-policy"
import { traceIdMiddleware } from "~/lib/trace"
import * as config from "~/lib/config"

let regularApiKeys: Array<string>
let adminApiKeys: Array<string>

function createApp() {
  const app = new Hono()

  app.use(
    "*",
    createAuthMiddleware({
      getApiKeys: () => regularApiKeys,
      allowUnauthenticatedPaths: [],
      shouldSkipPath: (path) => path.startsWith("/admin/"),
    }),
  )
  app.use(
    "/admin/*",
    createAuthMiddleware({
      getApiKeys: () => adminApiKeys,
      allowUnauthenticatedPaths: [],
      allowWhenNoApiKeys: false,
    }),
  )

  app.all("/models", (c) => c.json({ ok: true, scope: "default" }))
  app.all("/admin/config/model-mappings", (c) =>
    c.json({ ok: true, scope: "admin" }),
  )

  return app
}

beforeEach(() => {
  regularApiKeys = ["regular-key"]
  adminApiKeys = ["admin-key"]
})

describe("request auth middleware", () => {
  test.each([undefined, false, true])(
    "reports usage isolation and enforces subscription visibility (%s)",
    async (isolated) => {
      const setting = spyOn(config, "getConfig").mockReturnValue({
        auth: {
          apiKeyConfigs: [{ id: "client", key: "regular-key" }],
          isolateApiKeyUsage: isolated,
        },
      })
      try {
        const app = new Hono()
        app.use("*", traceIdMiddleware)
        app.use("*", createAuthMiddleware())
        app.use("*", apiKeyPolicyMiddleware)
        app.get("/models", (c) =>
          c.json({ isolatedKeyId: getIsolatedApiKeyId() ?? null }),
        )
        app.get("/usage/codex", (c) => c.json({ available: true }))
        const headers = { "x-api-key": "regular-key" }
        const status = await app.request("/models", { headers })
        expect(await status.json()).toEqual({
          isolatedKeyId: isolated ? "client" : null,
        })
        expect(status.headers.get("X-API-Key-Usage-Isolated")).toBe(
          String(isolated === true),
        )
        expect((await app.request("/usage/codex", { headers })).status).toBe(
          isolated ? 403 : 200,
        )
      } finally {
        setting.mockRestore()
      }
    },
  )
  test("distinguishes an empty managed key list from disabled and expired keys", async () => {
    const setting = spyOn(config, "getConfig").mockReturnValue({
      auth: { apiKeyConfigs: [] },
    })
    try {
      const app = new Hono()
      app.use("*", createAuthMiddleware())
      app.get("/models", (c) => c.json({ ok: true }))
      expect((await app.request("/models")).status).toBe(200)

      setting.mockReturnValue({
        auth: {
          apiKeyConfigs: [
            { id: "disabled", key: "disabled-key", enabled: false },
            { id: "expired", key: "expired-key", expiresAt: "2000-01-01" },
          ],
        },
      })
      expect((await app.request("/models")).status).toBe(401)
      for (const key of ["disabled-key", "expired-key"]) {
        const response = await app.request("/models", {
          headers: { "x-api-key": key },
        })
        expect(response.status).toBe(401)
        expect(response.headers.get("WWW-Authenticate")).toBe(
          'Bearer realm="copilot-api"',
        )
      }
    } finally {
      setting.mockRestore()
    }
  })

  test("accepts regular api keys for protected non-admin routes", async () => {
    const app = createApp()
    const response = await app.request("/models", {
      headers: {
        "x-api-key": "regular-key",
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, scope: "default" })
  })

  test("accepts admin api key for admin routes", async () => {
    const app = createApp()
    const response = await app.request("/admin/config/model-mappings", {
      headers: {
        authorization: "Bearer admin-key",
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, scope: "admin" })
  })

  test("rejects regular api keys on admin routes", async () => {
    const app = createApp()
    const response = await app.request("/admin/config/model-mappings", {
      headers: {
        "x-api-key": "regular-key",
      },
    })

    expect(response.status).toBe(401)
  })

  test("rejects admin api keys on protected non-admin routes", async () => {
    const app = createApp()
    const response = await app.request("/models", {
      headers: {
        "x-api-key": "admin-key",
      },
    })

    expect(response.status).toBe(401)
  })

  test("allows non-admin routes when no regular api keys are configured", async () => {
    regularApiKeys = []
    const app = createApp()
    const response = await app.request("/models")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, scope: "default" })
  })

  test("rejects admin routes when no admin api key is configured", async () => {
    adminApiKeys = []
    const app = createApp()
    const response = await app.request("/admin/config/model-mappings")

    expect(response.status).toBe(401)
  })

  test("allows options requests for admin routes without auth", async () => {
    const app = createApp()
    const response = await app.request("/admin/config/model-mappings", {
      method: "OPTIONS",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, scope: "admin" })
  })
})
