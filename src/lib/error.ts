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

export class CancelledError extends Error {}

function getFallbackHttpErrorMessage(error: HTTPError): string {
  return error.message || `HTTP ${error.response.status}`
}

async function readHttpErrorText(error: HTTPError): Promise<string> {
  try {
    const text = await error.response.text()
    return text || getFallbackHttpErrorMessage(error)
  } catch (readError) {
    consola.warn("Failed to read HTTP error response body:", readError)
    return getFallbackHttpErrorMessage(error)
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === "string") {
    return error
  }

  if (
    typeof error === "number"
    || typeof error === "boolean"
    || typeof error === "bigint"
  ) {
    return `${error}`
  }

  return "Unknown error"
}

export async function forwardError(c: Context, error: unknown) {
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

    const errorText = await readHttpErrorText(error)
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
        message: getErrorMessage(error),
        type: "error",
      },
    },
    500,
  )
}
