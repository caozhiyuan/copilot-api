import consola from "consola"

import type { AccountContext, AccountRuntime } from "~/lib/types/account"

import { HTTPError } from "~/lib/error"

export type ErrorDetails = {
  httpStatus: number
  errorName: string
  errorStatus: number | undefined
  errorMessage: string
  unauthorized: boolean
  ownershipMismatch: boolean
}

export type ErrorObservability = ErrorDetails & {
  upstreamErrorMessageRaw?: string
  upstreamErrorMessageReadFailed?: boolean
}

export function truncate(value: string, max: number = 2000): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

export function computeDiff(
  before?: number,
  after?: number,
): number | undefined {
  if (typeof before !== "number" || typeof after !== "number") return undefined
  return after - before
}

export function toAccountContext(account: AccountRuntime): AccountContext {
  return {
    accountLogin: account.accountLogin,
    githubToken: account.githubToken,
    copilotToken: account.copilotToken,
    ...(account.copilotApiUrl !== undefined ?
      { copilotApiUrl: account.copilotApiUrl }
    : {}),
    accountType: account.accountType,
    vsCodeVersion: account.vsCodeVersion,
    clientDeviceId: account.clientDeviceId,
    clientMachineId: account.clientMachineId,
    clientSessionId: account.clientSessionId,
  }
}

const OWNERSHIP_MISMATCH_PATTERN = /does not belong to this connection/i
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi
const OPAQUE_ID_PATTERN =
  /\b(?:msg|resp|chatcmpl|out|toolu|call|item)_[\w-]+\b/g
const UPSTREAM_ERROR_MAX_LENGTH = 1000
const UPSTREAM_ERROR_READ_FAILED_SENTINEL = "[upstream body read failed]"

function sanitizeUpstreamErrorMessage(value: string): string {
  return truncate(
    value
      .trim()
      .replaceAll(UUID_PATTERN, "<uuid>")
      .replaceAll(OPAQUE_ID_PATTERN, "<opaque_id>"),
    UPSTREAM_ERROR_MAX_LENGTH,
  )
}

type UpstreamErrorBody = {
  message?: unknown
  code?: unknown
  error?: { message?: unknown; code?: unknown }
}

function readErrorField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function formatUpstreamErrorBody(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    const text = payload.trim()
    return text.length > 0 ? text : undefined
  }

  if (!payload || typeof payload !== "object") {
    return undefined
  }

  const root = payload as UpstreamErrorBody
  const message =
    readErrorField(root.error?.message) ?? readErrorField(root.message)
  const code = readErrorField(root.error?.code) ?? readErrorField(root.code)

  if (message && code) {
    return `${message} [code:${code}]`
  }

  return message ?? (code ? `[code:${code}]` : undefined)
}

async function extractUpstreamErrorMessageRaw(error: unknown): Promise<{
  upstreamErrorMessageRaw?: string
  upstreamErrorMessageReadFailed: boolean
}> {
  if (!(error instanceof HTTPError)) {
    return { upstreamErrorMessageReadFailed: false }
  }

  try {
    const bodyText = await error.response.clone().text()
    if (!bodyText) {
      return { upstreamErrorMessageReadFailed: false }
    }

    let candidate: string | undefined

    try {
      candidate = formatUpstreamErrorBody(JSON.parse(bodyText) as unknown)
    } catch {
      candidate = bodyText
    }

    if (!candidate) {
      return { upstreamErrorMessageReadFailed: false }
    }

    const sanitized = sanitizeUpstreamErrorMessage(candidate)
    return {
      upstreamErrorMessageRaw: sanitized.length > 0 ? sanitized : undefined,
      upstreamErrorMessageReadFailed: false,
    }
  } catch (readError) {
    consola.warn("Failed to read upstream HTTP error response body:", {
      status: error.response.status,
      readError,
    })
    return { upstreamErrorMessageReadFailed: true }
  }
}

export function extractErrorDetails(error: unknown): ErrorDetails {
  const errorName = error instanceof Error ? error.name : "Error"
  const errorMessage =
    error instanceof Error ? truncate(error.message) : truncate(String(error))

  const errorStatus =
    error instanceof HTTPError ? error.response.status : undefined
  const httpStatus = errorStatus ?? 500

  const unauthorized = errorStatus === 401
  const ownershipMismatch =
    unauthorized && OWNERSHIP_MISMATCH_PATTERN.test(errorMessage)

  return {
    httpStatus,
    errorName,
    errorStatus,
    errorMessage,
    unauthorized,
    ownershipMismatch,
  }
}

export async function extractErrorObservability(
  error: unknown,
): Promise<ErrorObservability> {
  const details = extractErrorDetails(error)
  const { upstreamErrorMessageRaw, upstreamErrorMessageReadFailed } =
    await extractUpstreamErrorMessageRaw(error)
  const observableUpstreamErrorMessageRaw =
    upstreamErrorMessageRaw
    ?? (upstreamErrorMessageReadFailed ?
      UPSTREAM_ERROR_READ_FAILED_SENTINEL
    : undefined)

  return {
    ...details,
    ownershipMismatch:
      details.ownershipMismatch
      || (details.unauthorized
        && OWNERSHIP_MISMATCH_PATTERN.test(upstreamErrorMessageRaw ?? "")),
    upstreamErrorMessageRaw: observableUpstreamErrorMessageRaw,
    upstreamErrorMessageReadFailed,
  }
}

export function getUserVisibleErrorMessage(
  details: Pick<
    ErrorObservability,
    | "errorMessage"
    | "upstreamErrorMessageRaw"
    | "upstreamErrorMessageReadFailed"
  >,
): string {
  if (details.upstreamErrorMessageReadFailed) {
    return details.errorMessage
  }

  return details.upstreamErrorMessageRaw ?? details.errorMessage
}

/**
 * Returns true when the 401 indicates a genuine auth/token failure
 * (not an ownership mismatch) and the account should be marked failed.
 */
export function shouldMarkAccountFailed(
  details: ErrorDetails & { upstreamErrorMessageReadFailed?: boolean },
): boolean {
  return (
    details.unauthorized
    && !details.ownershipMismatch
    && details.upstreamErrorMessageReadFailed !== true
  )
}
