import type { AccountContext, AccountRuntime } from "~/lib/types/account"

import { HTTPError } from "~/lib/error"

export type ErrorDetails = {
  httpStatus: number
  errorName: string
  errorStatus: number | undefined
  errorMessage: string
  unauthorized: boolean
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
    githubToken: account.githubToken,
    copilotToken: account.copilotToken,
    ...(account.copilotApiUrl !== undefined ?
      { copilotApiUrl: account.copilotApiUrl }
    : {}),
    accountType: account.accountType,
    vsCodeVersion: account.vsCodeVersion,
  }
}

export function extractErrorDetails(error: unknown): ErrorDetails {
  const errorName = error instanceof Error ? error.name : "Error"
  const errorMessage =
    error instanceof Error ? truncate(error.message) : truncate(String(error))

  const errorStatus =
    error instanceof HTTPError ? error.response.status : undefined
  const httpStatus = errorStatus ?? 500

  return {
    httpStatus,
    errorName,
    errorStatus,
    errorMessage,
    unauthorized: errorStatus === 401,
  }
}
