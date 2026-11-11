import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  forwardError,
  HTTPError,
  UpstreamHeadersTimeoutError,
  UpstreamStreamInactivityTimeoutError,
} from "~/lib/error"

const forward = (error: unknown, signal?: AbortSignal) => {
  const app = new Hono()
  app.get("/", (c) => forwardError(c, error))
  return app.request("/", { signal })
}

const forwardHttp = (response: Response) =>
  forward(new HTTPError("Upstream request failed", response))

describe("upstream error forwarding", () => {
  test.each([
    {
      error: {
        type: "invalid_request_error",
        message: "Unsupported reasoning effort",
        code: "invalid_value",
        param: "reasoning.effort",
      },
    },
    {
      error: {
        type: "usage_limit_reached",
        message: "Usage limit reached",
        plan_type: "pro",
        resets_at: 1_800_000_000,
      },
    },
    {
      type: "error",
      error: { type: "rate_limit_error", message: "Too many requests" },
      request_id: "req-123",
    },
    { error: { code: "rate_limit_exceeded" } },
  ])("preserves the upstream structured error %j", async (body) => {
    const response = await forwardHttp(Response.json(body, { status: 429 }))

    expect(response.status).toBe(429)
    expect(await response.json()).toEqual(body)
    expect(response.headers.get("retry-after")).toBeNull()
  })

  test.each([400, 401, 403, 429, 500, 502, 503])(
    "preserves retry advice and diagnostic headers for HTTP %i",
    async (status) => {
      const body = {
        error: { type: "server_error", message: "Upstream request failed" },
      }
      const response = await forwardHttp(
        Response.json(body, {
          status,
          headers: {
            "retry-after": "12",
            "x-request-id": "req-123",
            "x-oai-request-id": "oai-req-123",
            "set-cookie": "private=value",
          },
        }),
      )

      expect(response.status).toBe(status)
      expect(response.headers.get("retry-after")).toBe("12")
      expect(response.headers.get("x-request-id")).toBe("req-123")
      expect(response.headers.get("x-oai-request-id")).toBe("oai-req-123")
      expect(response.headers.get("set-cookie")).toBeNull()
      expect(await response.json()).toEqual(body)
    },
  )

  test("keeps private upstream headers out of authentication errors", async () => {
    const response = await forwardHttp(
      new Response("upstream denied", {
        status: 401,
        headers: {
          "set-cookie": "upstream-session=secret; Path=/",
          "www-authenticate": "Bearer realm=upstream",
          "x-upstream-private": "do-not-forward",
        },
      }),
    )

    expect(response.status).toBe(401)
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("www-authenticate")).toBeNull()
    expect(response.headers.get("x-upstream-private")).toBeNull()
  })

  test("preserves HTTP-date retry advice", async () => {
    const retryAfter = "Wed, 01 Jan 2031 00:00:00 GMT"
    const response = await forwardHttp(
      Response.json(
        { error: { type: "server_error", message: "Service unavailable" } },
        { status: 503, headers: { "retry-after": retryAfter } },
      ),
    )

    expect(response.headers.get("retry-after")).toBe(retryAfter)
  })

  test("marks 400 invalid_request_body errors as non-retryable", async () => {
    const response = await forwardHttp(
      Response.json(
        {
          error: {
            message: "Missing required parameter: 'input[6].content[1].text'.",
            code: "invalid_request_body",
          },
        },
        { status: 400 },
      ),
    )

    expect(response.status).toBe(400)
    expect(response.headers.get("x-should-retry")).toBe("false")
  })

  test("marks 400 invalid_request_error errors as non-retryable", async () => {
    const response = await forwardHttp(
      Response.json(
        {
          error: {
            type: "invalid_request_error",
            message: "Unsupported parameter",
          },
        },
        { status: 400 },
      ),
    )

    expect(response.headers.get("x-should-retry")).toBe("false")
  })

  test.each([429, 500, 502])(
    "keeps transient upstream HTTP %i errors retryable",
    async (status) => {
      const response = await forwardHttp(
        Response.json(
          {
            error: {
              type: "invalid_request_error",
              code: "invalid_request_body",
              message: "Transient upstream failure",
            },
          },
          { status },
        ),
      )

      expect(response.headers.get("x-should-retry")).toBeNull()
    },
  )

  test.each([401, 403, 404])(
    "leaves the retry hint off for non-invalid-request HTTP %i errors",
    async (status) => {
      const response = await forwardHttp(
        Response.json(
          { error: { type: "server_error", message: "Upstream error" } },
          { status },
        ),
      )

      expect(response.headers.get("x-should-retry")).toBeNull()
    },
  )

  test.each([
    "upstream unavailable",
    "null",
    '{"error":"unavailable"}',
    '{"error":null}',
    '{"error":[]}',
  ])("keeps the fallback envelope for %s", async (body) => {
    const response = await forwardHttp(new Response(body, { status: 502 }))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: { message: body, type: "error" },
    })
  })

  test.each([
    new UpstreamHeadersTimeoutError(1_000),
    new UpstreamStreamInactivityTimeoutError(2_000),
  ])("preserves timeout responses for %s", async (error) => {
    const response = await forward(error)

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({
      error: { message: error.message, type: "upstream_timeout" },
    })
  })

  test("preserves client cancellation responses", async () => {
    const controller = new AbortController()
    controller.abort()
    const response = await forward(new Error("Stopped"), controller.signal)

    expect(response.status).toBe(499)
    expect(await response.text()).toBe("")
  })

  test("preserves abort error responses", async () => {
    const error = new Error("Stopped")
    error.name = "AbortError"

    expect((await forward(error)).status).toBe(499)
  })

  test("preserves unexpected error responses", async () => {
    const response = await forward(new Error("Unexpected failure"))

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { message: "Unexpected failure", type: "error" },
    })
  })
})
