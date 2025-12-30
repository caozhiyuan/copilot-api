import consola from "consola"
import fs from "node:fs"

import type {
  AccountContext,
  AccountRuntime,
  AccountType,
} from "~/lib/types/account"

import { HTTPError } from "~/lib/error"
import { getModels, type Model } from "~/services/copilot/get-models"
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
import { PATHS } from "./paths"

/**
 * Quota cache TTL in milliseconds (45 seconds).
 *
 * This TTL only applies to the cached quota used during the pre-request
 * check in `selectAccountForRequest`. After a request completes,
 * `finalizeQuota` calls `refreshQuota`, which always fetches the latest
 * quota from the API, effectively bypassing this TTL for active accounts.
 */
const QUOTA_CACHE_TTL = 45 * 1000

/** Debounce delay for registry reload in milliseconds */
const RELOAD_DEBOUNCE_MS = 500

export interface AccountRequestCandidate {
  modelId: string
  endpoint: string
}

export interface QuotaReservation {
  id: symbol
}

export type SelectAccountForRequestFailureReason =
  | "NO_ACCOUNTS"
  | "MODEL_NOT_SUPPORTED"
  | "NO_QUOTA"

export type SelectAccountForRequestResult =
  | {
      ok: true
      account: AccountRuntime
      selectedModel: Model
      endpoint: string
      costUnits: number
      reservation?: QuotaReservation
    }
  | {
      ok: false
      reason: SelectAccountForRequestFailureReason
    }

/**
 * Manages multiple GitHub Copilot accounts at runtime.
 * Handles account selection, token refresh, and quota management.
 */
export class AccountsManager {
  private accounts: Map<string, AccountRuntime> = new Map()
  private accountOrder: Array<string> = []
  private temporaryAccount?: AccountRuntime
  private vsCodeVersion?: string

  // Registry file watcher for hot reload
  private registryWatcher?: fs.FSWatcher
  private reloadDebounceTimer?: ReturnType<typeof setTimeout>
  private isReloading = false

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

    // Start watching the registry file for hot reload
    this.startRegistryWatcher()
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
      const user = await getGitHubUser({
        githubToken: token,
        accountType: "individual",
      })
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
    const intervalMs = Math.max((refreshInSeconds - 60) * 1000, 1000)

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
   * Uses a flag to prevent concurrent refresh calls.
   */
  async refreshQuota(account: AccountRuntime): Promise<void> {
    if (account.quotaRefreshPromise) {
      await account.quotaRefreshPromise
      return
    }

    const promise = (async () => {
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
        if (error instanceof HTTPError && error.response.status === 401) {
          this.markAccountFailed(account.id, "Unauthorized (401)")
          return
        }

        consola.error(`Failed to refresh quota for ${account.id}:`, error)
        // Don't mark as failed for non-401 quota refresh errors
      } finally {
        // eslint-disable-next-line require-atomic-updates
        account.isRefreshingQuota = false
        // eslint-disable-next-line require-atomic-updates
        account.quotaRefreshPromise = undefined
      }
    })()

    account.isRefreshingQuota = true
    account.quotaRefreshPromise = promise

    await promise
  }

  /**
   * Check if quota cache is expired.
   */
  private isQuotaCacheExpired(account: AccountRuntime): boolean {
    if (!account.lastQuotaFetch) return true
    return Date.now() - account.lastQuotaFetch > QUOTA_CACHE_TTL
  }

  private isAccountFailed(account: AccountRuntime): boolean {
    return account.failed === true
  }

  private isModelSupportedForEndpoint(model: Model, endpoint: string): boolean {
    if (endpoint === "/responses") {
      return model.supported_endpoints?.includes(endpoint) ?? false
    }

    const supported = model.supported_endpoints
    if (!supported) {
      return true
    }

    return supported.includes(endpoint)
  }

  private getCostUnits(model: Model): number {
    // Per user decision: missing billing => treat as free (costUnits = 0)
    const billing = model.billing
    if (!billing) {
      return 0
    }

    if (billing.is_premium !== true) {
      return 0
    }

    const multiplier = billing.multiplier
    if (
      typeof multiplier !== "number"
      || !Number.isFinite(multiplier)
      || multiplier <= 0
    ) {
      return 1
    }

    return multiplier
  }

  private getEffectivePremiumRemaining(
    account: AccountRuntime,
  ): number | undefined {
    if (account.premiumRemaining === undefined) {
      return undefined
    }

    const reserved = account.premiumReserved ?? 0
    return account.premiumRemaining - reserved
  }

  private reservePremiumUnits(
    account: AccountRuntime,
    units: number,
  ): QuotaReservation | undefined {
    if (units <= 0) {
      return undefined
    }

    const id = Symbol("quotaReservation")

    if (!account.premiumReservations) {
      account.premiumReservations = new Map()
    }

    account.premiumReservations.set(id, units)
    account.premiumReserved = (account.premiumReserved ?? 0) + units

    return { id }
  }

  private releasePremiumReservation(
    account: AccountRuntime,
    reservation?: QuotaReservation,
  ): void {
    if (!reservation) {
      return
    }

    const reservations = account.premiumReservations
    if (!reservations) {
      return
    }

    const reservedUnits = reservations.get(reservation.id)
    if (reservedUnits === undefined) {
      return
    }

    reservations.delete(reservation.id)

    const nextReserved = (account.premiumReserved ?? 0) - reservedUnits
    account.premiumReserved = Math.max(0, nextReserved)

    if (reservations.size === 0) {
      account.premiumReservations = undefined
    }
  }

  private pickSupportedCandidate(
    account: AccountRuntime,
    candidates: Array<AccountRequestCandidate>,
  ): { candidate: AccountRequestCandidate; model: Model } | null {
    const models = account.models?.data
    if (!models) {
      return null
    }

    for (const candidate of candidates) {
      const model = models.find((m) => m.id === candidate.modelId)
      if (!model) {
        continue
      }

      if (!this.isModelSupportedForEndpoint(model, candidate.endpoint)) {
        continue
      }

      return { candidate, model }
    }

    return null
  }

  /**
   * Select an available account for a specific request (model + endpoint).
   * Uses reservation to avoid oversubscribing premium quota under concurrency.
   */
  // eslint-disable-next-line complexity
  async selectAccountForRequest(
    candidates: Array<AccountRequestCandidate>,
  ): Promise<SelectAccountForRequestResult> {
    if (candidates.length === 0) {
      throw new Error("selectAccountForRequest requires at least one candidate")
    }

    const orderedAccounts: Array<AccountRuntime> = []

    if (this.temporaryAccount) {
      orderedAccounts.push(this.temporaryAccount)
    }

    for (const id of this.accountOrder) {
      const account = this.accounts.get(id)
      if (account) {
        orderedAccounts.push(account)
      }
    }

    if (orderedAccounts.length === 0) {
      return { ok: false, reason: "NO_ACCOUNTS" }
    }

    let supportedCandidateFound = false

    for (const account of orderedAccounts) {
      if (this.isAccountFailed(account)) {
        continue
      }

      const supported = this.pickSupportedCandidate(account, candidates)
      if (!supported) {
        continue
      }

      supportedCandidateFound = true

      const { candidate, model } = supported

      if (!account.unlimited && this.isQuotaCacheExpired(account)) {
        await this.refreshQuota(account)
      }

      if (this.isAccountFailed(account)) {
        continue
      }

      const costUnits = this.getCostUnits(model)

      if (account.unlimited || costUnits <= 0) {
        return {
          ok: true,
          account,
          selectedModel: model,
          endpoint: candidate.endpoint,
          costUnits,
        }
      }

      const effectiveRemaining = this.getEffectivePremiumRemaining(account)
      if (effectiveRemaining !== undefined && effectiveRemaining < costUnits) {
        continue
      }

      const reservation = this.reservePremiumUnits(account, costUnits)

      return {
        ok: true,
        account,
        selectedModel: model,
        endpoint: candidate.endpoint,
        costUnits,
        reservation,
      }
    }

    if (!supportedCandidateFound) {
      return { ok: false, reason: "MODEL_NOT_SUPPORTED" }
    }

    return { ok: false, reason: "NO_QUOTA" }
  }

  /**
   * Finalize quota after a request completes.
   * This releases any in-flight reservation and refreshes the actual quota from the API.
   */
  async finalizeQuota(
    account: AccountRuntime,
    reservation?: QuotaReservation,
  ): Promise<void> {
    this.releasePremiumReservation(account, reservation)

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
      return
    }

    if (this.temporaryAccount && this.temporaryAccount.id === id) {
      this.temporaryAccount.failed = true
      this.temporaryAccount.failureReason = reason
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
   * Start watching the registry file for changes.
   * Enables hot reload of accounts when the file is modified.
   */
  private startRegistryWatcher(): void {
    // Stop existing watcher if any
    this.stopRegistryWatcher()

    try {
      this.registryWatcher = fs.watch(
        PATHS.ACCOUNTS_REGISTRY_PATH,
        (eventType) => {
          // Only react to 'change' events (file content modified)
          if (eventType === "change") {
            this.scheduleReload()
          }
        },
      )

      // Handle watcher errors (e.g., file deleted)
      this.registryWatcher.on("error", (error) => {
        consola.debug("Registry watcher error:", error)
        // Try to restart the watcher after a delay
        setTimeout(() => this.startRegistryWatcher(), 1000)
      })

      consola.debug("Started registry file watcher")
    } catch (error) {
      consola.warn("Failed to start registry watcher:", error)
    }
  }

  /**
   * Schedule a registry reload with debouncing.
   */
  private scheduleReload(): void {
    // Clear existing timer
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer)
    }

    // Schedule reload after debounce delay
    this.reloadDebounceTimer = setTimeout(() => {
      void this.reloadRegistry()
    }, RELOAD_DEBOUNCE_MS)
  }

  /**
   * Reload the registry and perform incremental updates.
   * Only adds new accounts and removes deleted ones.
   */
  private async reloadRegistry(): Promise<void> {
    // Prevent concurrent reloads
    if (this.isReloading) {
      return
    }
    this.isReloading = true

    try {
      const newMetas = await listAccountsFromRegistry()
      const newIds = new Set(newMetas.map((m) => m.id))
      const currentIds = new Set(this.accountOrder)

      // Track changes for logging
      const added: Array<string> = []
      const removed: Array<string> = []

      // 1. Find and remove deleted accounts (currentIds - newIds)
      for (const id of currentIds) {
        if (!newIds.has(id)) {
          const account = this.accounts.get(id)
          if (account) {
            this.stopTokenRefresh(account)
            this.accounts.delete(id)
            removed.push(id)
          }
        }
      }

      // 2. Find and add new accounts (newIds - currentIds)
      for (const meta of newMetas) {
        if (!currentIds.has(meta.id)) {
          await this.addNewAccount(meta, added)
        }
      }

      // 3. Update accountOrder to reflect new order
      this.accountOrder = newMetas
        .map((m) => m.id)
        .filter((id) => this.accounts.has(id))

      // Log changes if any
      if (added.length > 0 || removed.length > 0) {
        const changes: Array<string> = []
        if (added.length > 0) {
          changes.push(`added: ${added.join(", ")}`)
        }
        if (removed.length > 0) {
          changes.push(`removed: ${removed.join(", ")}`)
        }
        consola.info(
          `Registry reloaded (${changes.join("; ")}). Total: ${this.accounts.size} account(s)`,
        )
      }
    } catch (error) {
      consola.error("Failed to reload registry:", error)
      this.shutdown()
      process.exit(1)
    } finally {
      this.isReloading = false
    }
  }

  /**
   * Helper to add a new account during reload.
   */
  private async addNewAccount(
    meta: { id: string; accountType: AccountType; addedAt: number },
    added: Array<string>,
  ): Promise<void> {
    const token = await loadAccountToken(meta.id)
    if (!token) {
      consola.warn(`No token found for new account ${meta.id}, skipping`)
      return
    }

    const runtime: AccountRuntime = {
      ...meta,
      githubToken: token,
      vsCodeVersion: this.vsCodeVersion,
    }

    try {
      await this.initializeAccount(runtime)
      this.accounts.set(meta.id, runtime)
      added.push(meta.id)
    } catch (error) {
      consola.error(`Failed to initialize new account ${meta.id}:`, error)
      runtime.failed = true
      runtime.failureReason = String(error)
      this.accounts.set(meta.id, runtime)
      added.push(`${meta.id} (failed)`)
    }
  }

  /**
   * Stop the registry file watcher.
   */
  private stopRegistryWatcher(): void {
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = undefined
    }
    if (this.registryWatcher) {
      this.registryWatcher.close()
      this.registryWatcher = undefined
    }
  }

  /**
   * Shutdown the manager and clean up resources.
   */
  shutdown(): void {
    this.stopRegistryWatcher()
    this.stopAllTokenRefresh()
    this.accounts.clear()
    this.accountOrder = []
    this.temporaryAccount = undefined
  }
}

/** Singleton instance of AccountsManager */
export const accountsManager = new AccountsManager()
