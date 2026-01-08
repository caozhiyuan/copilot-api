import { expect, test } from "bun:test"
import { Hono } from "hono"

import {
  createApiKeyAuthMiddleware,
  isProtectedPath,
} from "../src/lib/api-key-auth"

function createTestApp(getKey: () => string | undefined) {
  const app = new Hono()

  app.use(
    "*",
    createApiKeyAuthMiddleware({
      getConfiguredApiKey: getKey,
    }),
  )

  // Unprotected
  app.get("/", (c) => c.text("ok"))

  // Protected (per requirements)
  app.get("/token", (c) => c.text("token"))

  app.get("/usage", (c) => c.text("usage"))
  app.get("/usage/:accountIndex", (c) => c.text("usage-item"))

  app.get("/v1/models", (c) => c.text("v1-models"))
  app.options("/v1/models", (c) => c.text("v1-models-preflight"))

  app.post("/chat/completions", (c) => c.text("chat"))
  app.post("/embeddings", (c) => c.text("embeddings"))
  app.get("/models", (c) => c.text("models"))
  app.post("/responses", (c) => c.text("responses"))

  return app
}

test("isProtectedPath matches intended endpoints", () => {
  expect(isProtectedPath("/v1/models")).toBe(true)
  expect(isProtectedPath("/v1/models/")).toBe(true)
  expect(isProtectedPath("/v1/messages")).toBe(true)

  expect(isProtectedPath("/token")).toBe(true)
  expect(isProtectedPath("/token/")).toBe(true)

  expect(isProtectedPath("/usage")).toBe(true)
  expect(isProtectedPath("/usage/0")).toBe(true)

  expect(isProtectedPath("/chat/completions")).toBe(true)
  expect(isProtectedPath("/embeddings")).toBe(true)
  expect(isProtectedPath("/models")).toBe(true)
  expect(isProtectedPath("/responses")).toBe(true)

  expect(isProtectedPath("/")).toBe(false)
  expect(isProtectedPath("/admin")).toBe(false)
  expect(isProtectedPath("/api/admin/meta")).toBe(false)
})

test("allows protected routes when no key is configured", async () => {
  const app = createTestApp(() => undefined)

  const res = await app.fetch(new Request("http://local/v1/models"))
  expect(res.status).toBe(200)
})

test("denies requests without key when configured", async () => {
  const app = createTestApp(() => "k")

  const res = await app.fetch(new Request("http://local/v1/models"))
  expect(res.status).toBe(401)

  const body = (await res.json()) as {
    error: { message: string; type: string }
  }

  expect(body.error.type).toBe("unauthorized")
  expect(typeof body.error.message).toBe("string")
  expect(body.error.message.length).toBeGreaterThan(0)
})

test("accepts Authorization: Bearer <key>", async () => {
  const app = createTestApp(() => "k")

  const res = await app.fetch(
    new Request("http://local/v1/models", {
      headers: {
        authorization: "Bearer k",
      },
    }),
  )

  expect(res.status).toBe(200)
})

test("accepts x-api-key: <key>", async () => {
  const app = createTestApp(() => "k")

  const res = await app.fetch(
    new Request("http://local/v1/models", {
      headers: {
        "x-api-key": "k",
      },
    }),
  )

  expect(res.status).toBe(200)
})

test("does not protect non-listed routes", async () => {
  const app = createTestApp(() => "k")

  const res = await app.fetch(new Request("http://local/"))
  expect(res.status).toBe(200)
})

test("bypasses auth for OPTIONS (CORS preflight)", async () => {
  const app = createTestApp(() => "k")

  const res = await app.fetch(
    new Request("http://local/v1/models", {
      method: "OPTIONS",
    }),
  )

  expect(res.status).toBe(200)
})

test("server enforces API key on protected routes", async () => {
  const envKey = process.env.COPILOT_API_KEY
  process.env.COPILOT_API_KEY = "k"

  try {
    const { server } = await import("../src/server")

    const resV1 = await server.fetch(new Request("http://local/v1/models"))
    expect(resV1.status).toBe(401)

    const resModels = await server.fetch(new Request("http://local/models"))
    expect(resModels.status).toBe(401)

    const body = (await resV1.json()) as {
      error: { message: string; type: string }
    }
    expect(body.error.type).toBe("unauthorized")
  } finally {
    if (envKey === undefined) {
      delete process.env.COPILOT_API_KEY
    } else {
      // eslint-disable-next-line require-atomic-updates
      process.env.COPILOT_API_KEY = envKey
    }
  }
})
