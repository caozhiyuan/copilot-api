import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export class UpstreamHeadersTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Upstream did not return headers within ${timeoutMs}ms`)
    this.name = "UpstreamHeadersTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

export class UpstreamStreamInactivityTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Upstream stream was inactive for ${timeoutMs}ms`)
    this.name = "UpstreamStreamInactivityTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

export async function forwardError(
  c: Context,
  error: unknown,
): Promise<Response> {
  // Undici wraps request-body stream errors in a fetch TypeError on Node.
  if (error instanceof TypeError && error.cause instanceof HTTPError) {
    error = error.cause
  }

  if (
    error instanceof UpstreamHeadersTimeoutError
    || error instanceof UpstreamStreamInactivityTimeoutError
  ) {
    consola.error("Error occurred:", error)
    return c.json(
      {
        error: {
          message: error.message,
          type: "upstream_timeout",
        },
      },
      504,
    )
  }

  if (c.req.raw.signal.aborted || isAbortError(error)) {
    return new Response(null, {
      status: 499,
      statusText: "Client Closed Request",
    })
  }

  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    for (const [name, value] of error.response.headers) {
      const lowerName = name.toLowerCase()
      if (
        lowerName === "retry-after"
        || lowerName === "x-request-id"
        || lowerName === "x-oai-request-id"
        || (error.response.status === 429 && lowerName.startsWith("x-"))
      ) {
        c.header(name, value)
      }
    }

    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)
    if (isUpstreamErrorResponse(errorJson)) {
      return c.json(errorJson, error.response.status as ContentfulStatusCode)
    }
    return c.json(
      {
        error: {
          message: errorText,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError"

type UpstreamErrorResponse = Record<string, unknown> & {
  error: Record<string, unknown>
}

const isUpstreamErrorResponse = (
  value: unknown,
): value is UpstreamErrorResponse => {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false
  }
  const error = value.error
  return typeof error === "object" && error !== null && !Array.isArray(error)
}
