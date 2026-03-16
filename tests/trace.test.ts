import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { requestContext } from "~/lib/request-context"
import { traceIdMiddleware } from "~/lib/trace"

const createTracingApp = () => {
  const app = new Hono()

  app.use(traceIdMiddleware)

  app.get("/trace", (c) => {
    const traceId = requestContext.getStore()?.traceId ?? null
    return c.json({ traceId })
  })

  app.get("/trace-stream", (c) => {
    return streamSSE(c, async (stream) => {
      const traceId = requestContext.getStore()?.traceId ?? null

      await stream.writeSSE({
        event: "trace",
        data: JSON.stringify({ traceId }),
      })
    })
  })

  return app
}

describe("traceIdMiddleware", () => {
  test("sanitizes a valid client trace id and exposes it via request context", async () => {
    const app = createTracingApp()

    const response = await app.request("/trace", {
      headers: {
        "x-trace-id": "  trace-123_ABC  ",
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-trace-id")).toBe("trace-123_ABC")
    expect(await response.json()).toEqual({ traceId: "trace-123_ABC" })
  })

  test("falls back to a generated trace id for invalid input and preserves it in SSE", async () => {
    const app = createTracingApp()

    const response = await app.request("/trace-stream", {
      headers: {
        "x-trace-id": "bad trace value",
      },
    })

    expect(response.status).toBe(200)

    const traceId = response.headers.get("x-trace-id")

    expect(traceId).not.toBeNull()

    if (!traceId) {
      throw new Error("Expected x-trace-id response header")
    }

    expect(traceId).not.toBe("bad trace value")
    expect(traceId).toMatch(/^\w[\w.-]*$/)

    const body = await response.text()

    expect(body).toContain("event: trace")
    expect(body).toContain(`"traceId":"${traceId}"`)
  })
})
