import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import { BodySizeLimitExceededError } from "~/lib/bounded-body"
import {
  MODEL_NOT_ALLOWED_ERROR,
  ModelNotAllowedError,
} from "~/lib/model-admission"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export class UpstreamResponseSizeLimitExceededError extends Error {
  readonly maxBytes: number

  constructor(maxBytes: number) {
    super(`Upstream response exceeds the size limit of ${maxBytes} bytes`)
    this.name = "UpstreamResponseSizeLimitExceededError"
    this.maxBytes = maxBytes
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
  if (error instanceof ModelNotAllowedError) {
    return c.json({ error: MODEL_NOT_ALLOWED_ERROR }, 400)
  }

  if (error instanceof BodySizeLimitExceededError) {
    return c.json(
      {
        error: {
          message: error.message,
          type: "invalid_request_error",
        },
      },
      413,
    )
  }

  if (error instanceof UpstreamResponseSizeLimitExceededError) {
    consola.error("Error occurred:", error)
    return c.json(
      {
        error: {
          message: error.message,
          type: "upstream_error",
        },
      },
      502,
    )
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
    if (error.response.status === 429) {
      for (const [name, value] of error.response.headers) {
        const lowerName = name.toLowerCase()
        if (lowerName === "retry-after" || lowerName.startsWith("x-")) {
          c.header(name, value)
        }
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
