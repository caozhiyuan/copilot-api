import consola from "consola"

import { resetAgent } from "./proxy"

const RETRYABLE_CODES = new Set([
  "ENETUNREACH",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
])

const MAX_RETRIES = 2
const RETRY_DELAYS = [500, 1500]

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false
  const cause = (error as { cause?: { code?: string } }).cause
  if (cause?.code && RETRYABLE_CODES.has(cause.code)) return true
  if (error.message === "fetch failed") return true
  return false
}

export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  let lastError: unknown

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetch(input, init)
    } catch (error) {
      lastError = error
      if (!isNetworkError(error) || attempt === MAX_RETRIES) {
        throw error
      }

      const causeCode =
        (error as { cause?: { code?: string } }).cause?.code ?? ""
      consola.warn(
        `Network error (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${RETRY_DELAYS[attempt]}ms: ${(error as Error).message} ${causeCode}`,
      )

      if (attempt === 0) {
        resetAgent()
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]))
    }
  }

  throw lastError
}
