import { expect, test } from "bun:test"
import { Hono } from "hono"

import { forwardError, HTTPError } from "../src/lib/error"

function createUnreadableResponse(status: number): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("body exploded"))
      },
    }),
    { status },
  )
}

test("forwardError preserves HTTP status when HTTPError body is unreadable", async () => {
  const app = new Hono()

  app.get("/", async (c) => {
    return forwardError(
      c,
      new HTTPError("Unauthorized", createUnreadableResponse(401)),
    )
  })

  const response = await app.fetch(new Request("http://local/"))

  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({
    error: {
      message: "Unauthorized",
      type: "error",
    },
  })
})

test("forwardError returns string throws safely", async () => {
  const app = new Hono()

  app.get("/", async (c) => forwardError(c, "plain failure"))

  const response = await app.fetch(new Request("http://local/"))

  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({
    error: {
      message: "plain failure",
      type: "error",
    },
  })
})

test("forwardError returns null throws safely", async () => {
  const app = new Hono()

  app.get("/", async (c) => forwardError(c, null))

  const response = await app.fetch(new Request("http://local/"))

  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({
    error: {
      message: "Unknown error",
      type: "error",
    },
  })
})

test("forwardError falls back for Error instances with empty messages", async () => {
  const app = new Hono()

  app.get("/", async (c) => forwardError(c, new Error("")))

  const response = await app.fetch(new Request("http://local/"))

  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({
    error: {
      message: "Unknown error",
      type: "error",
    },
  })
})
