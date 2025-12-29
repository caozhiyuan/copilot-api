import consola from "consola"

import type {
  AccountContext,
  AccountRuntime,
  AccountType,
} from "~/lib/types/account"

import { getModels } from "~/services/copilot/get-models"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"
import { getGitHubUser } from "~/services/github/get-user"

import {
  hasLegacyToken,
  hasRegistry,
  listAccountsFromRegistry,
  loadAccountToken,
  readLegacyToken,
  saveAccountToken,
  addAccountToRegistry,
} from "./accounts-registry"

/** Quota cache TTL in milliseconds (45 seconds) */
const QUOTA_CACHE_TTL = 45 * 1000

/**
 * Manages multiple GitHub Copilot accounts at runtime.
 * Handles account selection, token refresh, and quota management.
 */
export class AccountsManager {
  private accounts: Map<string, AccountRuntime> = new Map()
  private accountOrder: Array<string> = []
  private temporaryAccount?: AccountRuntime
  private vsCodeVersion?: string

  /**
   * Initialize the accounts manager.
   * Loads accounts from registry and migrates legacy token if needed.
   */
  async initialize(vsCodeVersion?: string): Promise<void> {
    this.vsCodeVersion = vsCodeVersion

    // Check if we need to migrate legacy token
    const hasReg = await hasRegistry()
    const hasLegacy = await hasLegacyToken()

    if (!hasReg && hasLegacy) {
      await this.migrateLegacyToken()
    }

    // Load accounts from registry
    const accountMetas = await listAccountsFromRegistry()

    for (const meta of accountMetas) {
      const token = await loadAccountToken(meta.id)
      if (!token) {
        consola.warn(`No token found for account ${meta.id}, skipping`)
        continue
      }

      const runtime: AccountRuntime = {
        ...meta,
        githubToken: token,
        vsCodeVersion: this.vsCodeVersion,
      }

      this.accounts.set(meta.id, runtime)
      this.accountOrder.push(meta.id)
    }

    // Initialize Copilot tokens for all accounts
    for (const account of this.accounts.values()) {
      try {
        await this.initializeAccount(account)
      } catch (error) {
        consola.error(`Failed to initialize account ${account.id}:`, error)
        account.failed = true
        account.failureReason = String(error)
      }
    }

    consola.info(`Loaded ${this.accounts.size} account(s)`)
  }

  /**
   * Initialize a single account: get Copilot token and start refresh timer.
   */
  private async initializeAccount(account: AccountRuntime): Promise<void> {
    const ctx = this.toAccountContext(account)

    // Get Copilot token
    const { token, refresh_in } = await getCopilotToken(ctx)
    // eslint-disable-next-line require-atomic-updates
    account.copilotToken = token

    // Start token refresh timer
    this.startTokenRefresh(account, refresh_in)

    // Get models
    const updatedCtx = this.toAccountContext(account)
    // eslint-disable-next-line require-atomic-updates
    account.models = await getModels(updatedCtx)

    // Refresh quota
    await this.refreshQuota(account)

    consola.debug(`Account ${account.id} initialized`)
  }

  /**
   * Migrate legacy github_token to the new multi-account system.
   */
  private async migrateLegacyToken(): Promise<void> {
    const token = await readLegacyToken()
    if (!token) return

    try {
      // Get user info to determine the account ID
      const user = await getGitHubUser({ githubToken: token } as AccountContext)
      const id = user.login

      // Save token to new location
      await saveAccountToken(id, token)

      // Add to registry
      await addAccountToRegistry({
        id,
        accountType: "individual",
        addedAt: Date.now(),
      })

      consola.info(`Migrated legacy token to account: ${id}`)
    } catch (error) {
      consola.error("Failed to migrate legacy token:", error)
    }
  }

  /**
   * Start token refresh timer for an account.
   */
  private startTokenRefresh(
    account: AccountRuntime,
    refreshInSeconds: number,
  ): void {
    // Stop existing timer if any
    this.stopTokenRefresh(account)

    // Refresh 60 seconds before expiration
    const intervalMs = (refreshInSeconds - 60) * 1000

    account.refreshTimer = setInterval(async () => {
      try {
        const ctx = this.toAccountContext(account)
        const { token, refresh_in } = await getCopilotToken(ctx)
        // eslint-disable-next-line require-atomic-updates
        account.copilotToken = token
        consola.debug(`Refreshed token for account ${account.id}`)

        // Update the timer with new refresh interval
        this.startTokenRefresh(account, refresh_in)
      } catch (error) {
        consola.error(`Failed to refresh token for ${account.id}:`, error)

        account.failed = true

        account.failureReason = String(error)
      }
    }, intervalMs)
  }

  /**
   * Stop token refresh timer for an account.
   */
  private stopTokenRefresh(account: AccountRuntime): void {
    if (account.refreshTimer) {
      clearInterval(account.refreshTimer)
      account.refreshTimer = undefined
    }
  }

  /**
   * Stop all token refresh timers.
   */
  private stopAllTokenRefresh(): void {
    for (const account of this.accounts.values()) {
      this.stopTokenRefresh(account)
    }
    if (this.temporaryAccount) {
      this.stopTokenRefresh(this.temporaryAccount)
    }
  }

  /**
   * Refresh quota information for an account.
   */
  async refreshQuota(account: AccountRuntime): Promise<void> {
    try {
      const ctx = this.toAccountContext(account)
      const usage = await getCopilotUsage(ctx)
      const premium = usage.quota_snapshots.premium_interactions

      // eslint-disable-next-line require-atomic-updates
      account.premiumRemaining = premium.remaining
      // eslint-disable-next-line require-atomic-updates
      account.unlimited = premium.unlimited
      // eslint-disable-next-line require-atomic-updates
      account.lastQuotaFetch = Date.now()
      // eslint-disable-next-line require-atomic-updates
      account.failed = false
      // eslint-disable-next-line require-atomic-updates
      account.failureReason = undefined
    } catch (error) {
      consola.error(`Failed to refresh quota for ${account.id}:`, error)
      // Don't mark as failed for quota refresh errors
    }
  }

  /**
   * Check if quota cache is expired.
   */
  private isQuotaCacheExpired(account: AccountRuntime): boolean {
    if (!account.lastQuotaFetch) return true
    return Date.now() - account.lastQuotaFetch > QUOTA_CACHE_TTL
  }

  /**
   * Select an available account based on quota.
   * Returns null if all accounts are exhausted.
   */
  // eslint-disable-next-line complexity
  async selectAccount(): Promise<AccountRuntime | null> {
    // Check temporary account first (--github-token)
    if (this.temporaryAccount && !this.temporaryAccount.failed) {
      if (this.temporaryAccount.unlimited) {
        return this.temporaryAccount
      }

      if (this.isQuotaCacheExpired(this.temporaryAccount)) {
        await this.refreshQuota(this.temporaryAccount)
      }

      if (
        this.temporaryAccount.premiumRemaining === undefined
        || this.temporaryAccount.premiumRemaining > 0
      ) {
        // Optimistic decrement
        if (this.temporaryAccount.premiumRemaining !== undefined) {
          this.temporaryAccount.premiumRemaining--
        }
        return this.temporaryAccount
      }
    }

    // Check registered accounts in order
    for (const id of this.accountOrder) {
      const account = this.accounts.get(id)
      if (!account || account.failed) continue

      // Unlimited accounts are always available
      if (account.unlimited) {
        return account
      }

      // Refresh quota if cache is expired
      if (this.isQuotaCacheExpired(account)) {
        try {
          await this.refreshQuota(account)
        } catch (error) {
          // If quota refresh fails with 401, mark account as failed
          if (error instanceof Error && error.message.includes("401")) {
            this.markAccountFailed(id, "Unauthorized (401)")
            continue
          }
        }
      }

      // Check if account has remaining quota
      if (
        account.premiumRemaining === undefined
        || account.premiumRemaining > 0
      ) {
        // Optimistic decrement
        if (account.premiumRemaining !== undefined) {
          account.premiumRemaining--
        }
        return account
      }
    }

    return null
  }

  /**
   * Finalize quota after a request completes.
   * This refreshes the actual quota from the API.
   */
  async finalizeQuota(account: AccountRuntime): Promise<void> {
    try {
      await this.refreshQuota(account)
    } catch (error) {
      consola.debug(`Failed to finalize quota for ${account.id}:`, error)
    }
  }

  /**
   * Mark an account as failed.
   */
  markAccountFailed(id: string, reason: string): void {
    const account = this.accounts.get(id)
    if (account) {
      account.failed = true
      account.failureReason = reason
      consola.warn(`Account ${id} marked as failed: ${reason}`)
    }
  }

  /**
   * Get status of all accounts.
   */
  getAccountStatus(): Array<{
    id: string
    remaining?: number
    unlimited?: boolean
    failed?: boolean
    failureReason?: string
  }> {
    const statuses: Array<{
      id: string
      remaining?: number
      unlimited?: boolean
      failed?: boolean
      failureReason?: string
    }> = []

    if (this.temporaryAccount) {
      statuses.push({
        id: "(temporary)",
        remaining: this.temporaryAccount.premiumRemaining,
        unlimited: this.temporaryAccount.unlimited,
        failed: this.temporaryAccount.failed,
        failureReason: this.temporaryAccount.failureReason,
      })
    }

    for (const id of this.accountOrder) {
      const account = this.accounts.get(id)
      if (account) {
        statuses.push({
          id: account.id,
          remaining: account.premiumRemaining,
          unlimited: account.unlimited,
          failed: account.failed,
          failureReason: account.failureReason,
        })
      }
    }

    return statuses
  }

  /**
   * Set a temporary account from a GitHub token (--github-token).
   * This account takes priority over registered accounts.
   */
  async setTemporaryAccount(
    githubToken: string,
    accountType: AccountType,
  ): Promise<void> {
    const runtime: AccountRuntime = {
      id: "(temporary)",
      accountType,
      addedAt: Date.now(),
      githubToken,
      vsCodeVersion: this.vsCodeVersion,
    }

    try {
      await this.initializeAccount(runtime)
      this.temporaryAccount = runtime
      consola.info("Temporary account initialized")
    } catch (error) {
      consola.error("Failed to initialize temporary account:", error)
      throw error
    }
  }

  /**
   * Check if any accounts are available.
   */
  hasAccounts(): boolean {
    return this.accounts.size > 0 || this.temporaryAccount !== undefined
  }

  /**
   * Get the first available account's models.
   * Used for caching models in legacy compatibility mode.
   */
  getFirstAccountModels(): AccountRuntime["models"] {
    if (this.temporaryAccount?.models) {
      return this.temporaryAccount.models
    }

    for (const id of this.accountOrder) {
      const account = this.accounts.get(id)
      if (account?.models) {
        return account.models
      }
    }

    return undefined
  }

  /**
   * Get account context by index.
   * Index 0 is the temporary account (if exists), otherwise the first registered account.
   * Returns null if index is out of bounds.
   */
  getAccountContextByIndex(index: number): AccountContext | null {
    // Build the same order as getAccountStatus()
    const allAccounts: Array<AccountRuntime> = []

    if (this.temporaryAccount) {
      allAccounts.push(this.temporaryAccount)
    }

    for (const id of this.accountOrder) {
      const account = this.accounts.get(id)
      if (account) {
        allAccounts.push(account)
      }
    }

    if (index < 0 || index >= allAccounts.length) {
      return null
    }

    return this.toAccountContext(allAccounts[index])
  }

  /**
   * Get the total number of accounts (including temporary).
   */
  getAccountCount(): number {
    return (this.temporaryAccount ? 1 : 0) + this.accountOrder.length
  }

  /**
   * Convert AccountRuntime to AccountContext for service calls.
   */
  private toAccountContext(account: AccountRuntime): AccountContext {
    return {
      githubToken: account.githubToken,
      copilotToken: account.copilotToken,
      accountType: account.accountType,
      vsCodeVersion: account.vsCodeVersion,
    }
  }

  /**
   * Shutdown the manager and clean up resources.
   */
  shutdown(): void {
    this.stopAllTokenRefresh()
    this.accounts.clear()
    this.accountOrder = []
    this.temporaryAccount = undefined
  }
}

/** Singleton instance of AccountsManager */
export const accountsManager = new AccountsManager()
