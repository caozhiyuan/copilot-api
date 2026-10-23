import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { zstdDecompressionMiddleware } from "~/lib/zstd-request"
import { createServer } from "~/server"

const server = createServer()

const createApp = () => {
  const app = new Hono()

  app.use(zstdDecompressionMiddleware)
  app.post("/echo", async (c) =>
    c.json({
      contentEncoding: c.req.header("content-encoding") ?? null,
      contentLength: c.req.raw.headers.get("content-length"),
      payload: await c.req.json(),
    }),
  )

  return app
}

describe("zstd request middleware", () => {
  test("is registered only on Responses API routes", () => {
    const registeredPaths = server.routes
      .filter((route) => route.handler === zstdDecompressionMiddleware)
      .map((route) => route.path)

    expect(registeredPaths).toEqual([
      "/responses/*",
      "/v1/responses/*",
      "/:provider/v1/responses/*",
      "/:provider/responses/*",
    ])
  })

  test("decompresses zstd encoded json request bodies", async () => {
    const app = createApp()
    const payload = { model: "gpt-5", messages: [{ role: "user" }] }
    const body = await Bun.zstdCompress(JSON.stringify(payload))

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-length": String(body.byteLength),
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      contentEncoding: null,
      contentLength: null,
      payload,
    })
  })

  test("leaves unencoded request bodies unchanged", async () => {
    const app = createApp()
    const payload = { ok: true }

    const response = await app.request("/echo", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ payload })
  })

  test("rejects invalid zstd request bodies", async () => {
    const app = createApp()

    const response = await app.request("/echo", {
      body: "not-zstd",
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "Failed to decompress zstd request body.",
        type: "invalid_request_error",
      },
    })
  })
})
