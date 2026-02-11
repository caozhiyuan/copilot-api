import { expect, test } from "bun:test"
import { Hono } from "hono"

import { createAuthMiddleware } from "../src/lib/request-auth"

function createTestApp() {
  const app = new Hono()

  app.use(
    "*",
    createAuthMiddleware({
      getApiKeys: () => ["k"],
      allowUnauthenticatedPathPrefixes: ["/admin", "/api/admin"],
    }),
  )

  app.get("/", (c) => c.text("ok"))
  app.get("/admin", (c) => c.text("admin"))
  app.get("/api/admin/meta", (c) => c.text("meta"))
  app.get("/api/administrator", (c) => c.text("administrator"))
  app.get("/v1/models", (c) => c.text("models"))

  return app
}

test("allowUnauthenticatedPathPrefixes honors prefix boundary", async () => {
  const app = createTestApp()

  const adminRes = await app.fetch(new Request("http://localhost/admin"))
  expect(adminRes.status).toBe(200)

  const adminApiRes = await app.fetch(
    new Request("http://localhost/api/admin/meta"),
  )
  expect(adminApiRes.status).toBe(200)

  const fakePrefixRes = await app.fetch(
    new Request("http://localhost/api/administrator"),
  )
  expect(fakePrefixRes.status).toBe(401)
})

test("authenticated route requires valid key", async () => {
  const app = createTestApp()

  const unauthorized = await app.fetch(
    new Request("http://localhost/v1/models"),
  )
  expect(unauthorized.status).toBe(401)

  const authorized = await app.fetch(
    new Request("http://localhost/v1/models", {
      headers: {
        "x-api-key": "k",
      },
    }),
  )
  expect(authorized.status).toBe(200)
})

test("server keeps admin routes outside request auth middleware", async () => {
  const previousEnvKey = process.env.COPILOT_API_KEY
  process.env.COPILOT_API_KEY = "k"

  try {
    const { server } = await import("../src/server")

    const adminUi = await server.fetch(new Request("http://localhost/admin"))
    expect(adminUi.status).toBe(200)

    const adminApi = await server.fetch(
      new Request("http://localhost/api/admin/meta"),
    )
    expect(adminApi.status).toBe(200)

    const modelsUnauthorized = await server.fetch(
      new Request("http://localhost/v1/models"),
    )
    expect(modelsUnauthorized.status).toBe(401)
  } finally {
    if (previousEnvKey === undefined) {
      delete process.env.COPILOT_API_KEY
    } else {
      // eslint-disable-next-line require-atomic-updates
      process.env.COPILOT_API_KEY = previousEnvKey
    }
  }
})
