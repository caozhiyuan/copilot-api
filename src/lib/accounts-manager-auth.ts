import consola from "consola"

import type {
  AccountContext,
  AccountRuntime,
  AccountType,
} from "~/lib/types/account"
import type { QuotaDetail } from "~/services/github/get-copilot-usage"

export type AuthSnapshot = Readonly<{
  githubToken: string
  accountType: AccountType
}>

export const takeAuthSnapshot = (account: AccountRuntime): AuthSnapshot => ({
  githubToken: account.githubToken,
  accountType: account.accountType,
})

export const isAuthSnapshotCurrent = (
  account: AccountRuntime,
  snapshot: AuthSnapshot,
): boolean =>
  account.githubToken === snapshot.githubToken
  && account.accountType === snapshot.accountType

export const isSameAuthSnapshot = (
  a: AuthSnapshot | undefined,
  b: AuthSnapshot,
): boolean => {
  if (!a) return false
  return a.githubToken === b.githubToken && a.accountType === b.accountType
}

export const toAccountContextFromSnapshot = (
  account: AccountRuntime,
  snapshot: AuthSnapshot,
  copilotToken?: string,
): AccountContext => ({
  accountLogin: account.accountLogin,
  githubToken: snapshot.githubToken,
  copilotToken,
  ...(account.copilotApiUrl !== undefined ?
    { copilotApiUrl: account.copilotApiUrl }
  : {}),
  accountType: snapshot.accountType,
  vsCodeVersion: account.vsCodeVersion,
  clientDeviceId: account.clientDeviceId,
  clientMachineId: account.clientMachineId,
  clientSessionId: account.clientSessionId,
})

export const applyCopilotTokenIfCurrent = (
  account: AccountRuntime,
  snapshot: AuthSnapshot,
  copilotToken: string,
): boolean => {
  if (!isAuthSnapshotCurrent(account, snapshot)) {
    return false
  }

  account.copilotToken = copilotToken
  return true
}

export const applyModelsIfCurrent = (
  account: AccountRuntime,
  snapshot: AuthSnapshot,
  models: AccountRuntime["models"],
): boolean => {
  if (!isAuthSnapshotCurrent(account, snapshot)) {
    return false
  }

  account.models = models
  return true
}

export const applyTokenRefreshSuccessIfCurrent = (
  account: AccountRuntime,
  snapshot: AuthSnapshot,
  token: string,
): boolean => {
  if (!isAuthSnapshotCurrent(account, snapshot)) {
    return false
  }

  account.copilotToken = token
  account.failed = false
  account.failureReason = undefined
  return true
}

export const applyTokenRefreshFailureIfCurrent = (
  account: AccountRuntime,
  snapshot: AuthSnapshot,
  error: unknown,
): boolean => {
  if (!isAuthSnapshotCurrent(account, snapshot)) {
    return false
  }

  account.failed = true
  account.failureReason = String(error)
  return true
}

export const applyQuotaRefreshSuccessIfCurrent = (
  account: AccountRuntime,
  snapshot: AuthSnapshot,
  result: {
    premium: QuotaDetail
    copilotApiUrl?: string
  },
): boolean => {
  if (!isAuthSnapshotCurrent(account, snapshot)) {
    return false
  }

  const { premium, copilotApiUrl } = result

  account.premiumEntitlement = premium.entitlement
  account.premiumRemaining = premium.remaining
  account.unlimited = premium.unlimited
  account.overagePermitted = premium.overage_permitted
  if (copilotApiUrl) {
    account.copilotApiUrl = copilotApiUrl
  }
  account.lastQuotaFetch = Date.now()
  account.failed = false
  account.failureReason = undefined
  return true
}

export const setAccountFailedState = (
  account: AccountRuntime,
  reason: string,
): void => {
  account.failed = true
  account.failureReason = reason
  consola.warn(`Account ${account.id} marked as failed: ${reason}`)
}

export const applyUnauthorizedIfCurrent = (
  account: AccountRuntime,
  snapshot: AuthSnapshot,
  reason: string,
): boolean => {
  if (!isAuthSnapshotCurrent(account, snapshot)) {
    return false
  }

  setAccountFailedState(account, reason)
  return true
}
