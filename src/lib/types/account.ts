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

export interface AccountClientIdentity {
  /** Real GitHub login */
  login: string
  /** OAuth app namespace */
  oauthApp: string
  /** Enterprise domain namespace ("public" for github.com) */
  enterpriseDomain: string
  /** Account-scoped upstream device identifier */
  deviceId: string
  /** Account-scoped upstream machine identifier */
  machineId: string
  /** Creation timestamp for debugging/auditing */
  createdAt: number
}

/**
 * Registry file structure for storing account metadata.
 */
export interface AccountRegistry {
  /** Schema version for future migrations */
  version: 2
  /** Ordered list of accounts (order = priority) */
  accounts: Array<AccountMeta>
  /** Persistent client identities keyed by logical environment + login */
  clientIdentities: Partial<Record<string, AccountClientIdentity>>
}

/**
 * Runtime state for an account, including tokens and quota information.
 */
export interface AccountRuntime extends AccountMeta {
  /** Real GitHub login, used to resolve account-scoped identity */
  accountLogin?: string
  /** Persistent identity key used to load/store account-scoped identifiers */
  identityKey?: string
  /** GitHub personal access token */
  githubToken: string
  /** Copilot API token (obtained from GitHub) */
  copilotToken?: string
  /** Account-specific Copilot API base URL returned by GitHub */
  copilotApiUrl?: string
  /** VS Code version for API headers */
  vsCodeVersion?: string
  /** Account-scoped device identifier sent upstream */
  clientDeviceId?: string
  /** Account-scoped machine identifier sent upstream */
  clientMachineId?: string
  /** Account-scoped session identifier sent upstream */
  clientSessionId?: string
  /** Session refresh timer reference */
  sessionRefreshTimer?: ReturnType<typeof setTimeout>
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
  /** Real GitHub login */
  accountLogin?: string
  /** GitHub personal access token */
  githubToken: string
  /** Copilot API token */
  copilotToken?: string
  /** Account-specific Copilot API base URL */
  copilotApiUrl?: string
  /** Account subscription type */
  accountType: AccountType
  /** VS Code version for API headers */
  vsCodeVersion?: string
  /** Account-scoped device identifier */
  clientDeviceId?: string
  /** Account-scoped machine identifier */
  clientMachineId?: string
  /** Account-scoped session identifier */
  clientSessionId?: string
}
