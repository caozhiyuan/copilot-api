import type { ModelsResponse } from "~/services/copilot/get-models"

/**
 * Account type for GitHub Copilot subscription.
 */
export type AccountType = "individual" | "business" | "enterprise"

export const ACCOUNT_TYPE_VALUES: ReadonlyArray<AccountType> = [
  "individual",
  "business",
  "enterprise",
]

export function isAccountType(value: unknown): value is AccountType {
  return (
    typeof value === "string"
    && (ACCOUNT_TYPE_VALUES as ReadonlyArray<string>).includes(value)
  )
}

export function parseAccountType(value: unknown): AccountType {
  if (!isAccountType(value)) {
    throw new Error(
      `Invalid account type: ${String(value)}. Valid values: ${ACCOUNT_TYPE_VALUES.join(
        ", ",
      )}`,
    )
  }
  return value
}

/**
 * Metadata for a registered account, stored in the registry file.
 */
export interface AccountMeta {
  /** GitHub login (username) */
  id: string
  /** Account subscription type */
  accountType: AccountType
  /** Timestamp when the account was added */
  addedAt: number
}

/**
 * Registry file structure for storing account metadata.
 */
export interface AccountRegistry {
  /** Schema version for future migrations */
  version: 1
  /** Ordered list of accounts (order = priority) */
  accounts: Array<AccountMeta>
}

/**
 * Runtime state for an account, including tokens and quota information.
 */
export interface AccountRuntime extends AccountMeta {
  /** GitHub personal access token */
  githubToken: string
  /** Copilot API token (obtained from GitHub) */
  copilotToken?: string
  /** VS Code version for API headers */
  vsCodeVersion?: string
  /** Cached available models for this account */
  models?: ModelsResponse
  /** Timestamp of last models fetch */
  lastModelsFetch?: number
  /** Whether models refresh is in progress */
  isRefreshingModels?: boolean
  /** Promise for an in-flight models refresh */
  modelsRefreshPromise?: Promise<void>
  /** Total premium interactions quota entitlement */
  premiumEntitlement?: number
  /** Remaining premium interactions quota */
  premiumRemaining?: number
  /** Reserved premium interaction units for in-flight requests */
  premiumReserved?: number
  /** Internal reservation map for idempotent release */
  premiumReservations?: Map<symbol, number>
  /** Whether this account has unlimited quota */
  unlimited?: boolean
  /** Whether this account allows overage billing (enterprise feature) */
  overagePermitted?: boolean
  /** Timestamp of last quota fetch */
  lastQuotaFetch?: number
  /** Token refresh timer reference */
  refreshTimer?: ReturnType<typeof setInterval>
  /** Whether this account has failed (e.g., 401 error) */
  failed?: boolean
  /** Failure reason if failed */
  failureReason?: string
  /** Whether quota refresh is in progress (prevents concurrent refreshes) */
  isRefreshingQuota?: boolean
  /** Promise for an in-flight quota refresh (allows concurrent callers to await the same refresh) */
  quotaRefreshPromise?: Promise<void>
}

/**
 * Context required for making API calls on behalf of an account.
 * This is a subset of AccountRuntime used by service functions.
 */
export interface AccountContext {
  /** GitHub personal access token */
  githubToken: string
  /** Copilot API token */
  copilotToken?: string
  /** Account subscription type */
  accountType: AccountType
  /** VS Code version for API headers */
  vsCodeVersion?: string
}
