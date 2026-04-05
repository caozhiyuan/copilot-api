/* eslint-disable max-lines */
import consola from "consola"
import fs from "node:fs"

import type {
  AccountContext,
  AccountRuntime,
  AccountType,
} from "~/lib/types/account"

import {
  AccountAffinityCache,
  buildAffinityCacheKey,
  extractAffinityKey,
  isAffinityAccountUsable,
  type AffinityContext,
} from "~/lib/account-affinity"
import { resolveModelAlias } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { getModels, type Model } from "~/services/copilot/get-models"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"
import { getGitHubUser } from "~/services/github/get-user"

import {
  buildIdentityKey,
  createAccountSessionId,
  getCurrentIdentityEnvironment,
} from "./account-client-identity"
import {
  applyCopilotTokenIfCurrent,
  applyModelsIfCurrent,
  applyQuotaRefreshSuccessIfCurrent,
  applyTokenRefreshFailureIfCurrent,
  applyTokenRefreshSuccessIfCurrent,
  applyUnauthorizedIfCurrent,
  isAuthSnapshotCurrent,
  isSameAuthSnapshot,
  setAccountFailedState,
  takeAuthSnapshot,
  toAccountContextFromSnapshot,
  type AuthSnapshot,
} from "./accounts-manager-auth"
import {
  getCostUnits,
  getEffectivePremiumRemaining,
  releasePremiumReservation,
  reservePremiumUnits,
  type QuotaReservation,
} from "./accounts-manager-quota"
import {
  hasLegacyToken,
  hasRegistry,
  ensureAccountClientIdentity,
  listAccountsFromRegistry,
  loadAccountToken,
  readLegacyToken,
  saveAccountToken,
  addAccountToRegistry,
} from "./accounts-registry"
import { PATHS } from "./paths"

/** Quota cache TTL in milliseconds (45 seconds) for pre-request selection. */
const QUOTA_CACHE_TTL = 45 * 1000

/** Debounce delay for registry reload in milliseconds */
const RELOAD_DEBOUNCE_MS = 500

/** Registry watcher restart initial delay in milliseconds */
const WATCHER_RESTART_INITIAL_DELAY_MS = 1000
/** Registry watcher restart max delay in milliseconds */
const WATCHER_RESTART_MAX_DELAY_MS = 60 * 1000
/** Session refresh base interval in milliseconds. */
const SESSION_REFRESH_BASE_MS = 60 * 60 * 1000
/** Session refresh jitter window in milliseconds. */
const SESSION_REFRESH_JITTER_MS = 20 * 60 * 1000

export interface AccountRequestCandidate {
  modelId: string
  endpoint: string
}

export type { QuotaReservation } from "./accounts-manager-quota"
export type { AffinityContext } from "~/lib/account-affinity"

export type SelectAccountForRequestFailureReason =
  | "NO_ACCOUNTS"
  | "MODEL_NOT_SUPPORTED"
  | "NO_QUOTA"

type SelectAccountForRequestSuccess = {
  ok: true
  account: AccountRuntime
  selectedModel: Model
  endpoint: string
  costUnits: number
  reservation?: QuotaReservation
  /** Call after a successful upstream response to persist the affinity mapping. */
  confirmAffinity?: () => void
  /** Whether this selection was served from the affinity cache. */
  affinityHit?: boolean
  /** The cache key used for affinity lookup (e.g. `"session-1:claude-sonnet-4"`). */
  affinityCacheKey?: string
}

export type SelectAccountForRequestResult =
  | SelectAccountForRequestSuccess
  | {
      ok: false
      reason: SelectAccountForRequestFailureReason
    }

/** Manages multiple GitHub Copilot accounts at runtime. */
export class AccountsManager {
  private accounts: Map<string, AccountRuntime> = new Map()
  private accountOrder: Array<string> = []
  private temporaryAccount?: AccountRuntime
  private vsCodeVersion?: string
  private accountAffinityEnabled = true
  private affinityCache = new AccountAffinityCache()
  private loadBalanceCursor = 0

  private quotaRefreshSnapshotByAccount = new WeakMap<
    AccountRuntime,
    AuthSnapshot
  >()
  private modelsRefreshSnapshotByAccount = new WeakMap<
    AccountRuntime,
    AuthSnapshot
  >()
  private tokenRefreshEnabledAccounts = new WeakSet<AccountRuntime>()
  private modelsRefreshTimer?: ReturnType<typeof setTimeout>
  private modelsRefreshIntervalMs = 0

  // Registry file watcher for hot reload
  private registryWatcher?: fs.FSWatcher
  private reloadDebounceTimer?: ReturnType<typeof setTimeout>
  private registryWatcherRestartTimer?: ReturnType<typeof setTimeout>
  private registryWatcherRestartDelayMs = WATCHER_RESTART_INITIAL_DELAY_MS
  private isReloading = false

  /** Initialize accounts manager (load registry, migrate legacy token). */
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
        accountLogin: meta.id,
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

  setAccountAffinityEnabled(enabled: boolean): void {
    this.accountAffinityEnabled = enabled
    if (!enabled) {
      this.affinityCache.clear()
    }
  }

  setModelsRefreshIntervalMs(intervalMs: number): void {
    this.modelsRefreshIntervalMs =
      Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0
    this.scheduleModelsRefresh()
  }

  private computeTokenRefreshDelayMs(refreshInSeconds: number): number {
    return Math.max((refreshInSeconds - 60) * 1000, 1000)
  }

  private computeSessionRefreshDelayMs(): number {
    const randomDelay = Math.floor(Math.random() * SESSION_REFRESH_JITTER_MS)
    return SESSION_REFRESH_BASE_MS + randomDelay
  }

  private resolveAccountLogin(account: AccountRuntime): string {
    return account.accountLogin ?? account.id
  }

  private commitAccountIdentity(
    account: AccountRuntime,
    {
      identityKey,
      login,
      deviceId,
      machineId,
    }: {
      identityKey: string
      login: string
      deviceId: string
      machineId: string
    },
  ): void {
    account.accountLogin = login
    account.identityKey = identityKey
    account.clientDeviceId = deviceId
    account.clientMachineId = machineId
  }

  private async applyAccountIdentity(account: AccountRuntime): Promise<void> {
    const login = this.resolveAccountLogin(account)
    const { oauthApp, enterpriseDomain } = getCurrentIdentityEnvironment()
    const identityKey = buildIdentityKey({
      login,
      oauthApp,
      enterpriseDomain,
    })
    const identity = await ensureAccountClientIdentity({
      login,
      oauthApp,
      enterpriseDomain,
    })

    this.commitAccountIdentity(account, {
      identityKey,
      login,
      deviceId: identity.deviceId,
      machineId: identity.machineId,
    })

    if (!account.clientSessionId) {
      account.clientSessionId = createAccountSessionId()
      consola.debug(
        `Generated VSCode session ID for account ${account.id}: ${account.clientSessionId}`,
      )
    }

    this.startSessionRefresh(account)
  }

  private shouldContinueTokenRefresh(
    account: AccountRuntime,
    snapshot: AuthSnapshot,
  ): boolean {
    return (
      this.tokenRefreshEnabledAccounts.has(account)
      && isAuthSnapshotCurrent(account, snapshot)
    )
  }

  private async runTokenRefreshTick(
    account: AccountRuntime,
    snapshot: AuthSnapshot,
    refreshInSeconds: number,
  ): Promise<void> {
    if (!this.shouldContinueTokenRefresh(account, snapshot)) {
      return
    }

    try {
      const ctx = toAccountContextFromSnapshot(account, snapshot)
      const { token, refresh_in } = await getCopilotToken(ctx)

      if (!this.shouldContinueTokenRefresh(account, snapshot)) {
        return
      }

      const applied = applyTokenRefreshSuccessIfCurrent(
        account,
        snapshot,
        token,
      )
      if (!applied) {
        return
      }

      consola.debug(`Refreshed token for account ${account.id}`)

      // Schedule next refresh using the new refresh interval.
      if (!this.shouldContinueTokenRefresh(account, snapshot)) {
        return
      }
      this.startTokenRefresh(account, refresh_in)
    } catch (error) {
      consola.error(`Failed to refresh token for ${account.id}:`, error)

      if (!this.shouldContinueTokenRefresh(account, snapshot)) {
        return
      }

      applyTokenRefreshFailureIfCurrent(account, snapshot, error)

      // Retry using the previous refresh interval (best effort).
      if (!this.shouldContinueTokenRefresh(account, snapshot)) {
        return
      }
      this.startTokenRefresh(account, refreshInSeconds)
    }
  }

  private finalizeQuotaRefreshPromise(
    account: AccountRuntime,
    promise: Promise<void>,
  ): void {
    if (account.quotaRefreshPromise !== promise) {
      return
    }

    account.isRefreshingQuota = false
    account.quotaRefreshPromise = undefined
    this.quotaRefreshSnapshotByAccount.delete(account)
  }

  /** Initialize a single account. */
  private async initializeAccount(account: AccountRuntime): Promise<void> {
    await this.applyAccountIdentity(account)
    const snapshot = takeAuthSnapshot(account)

    try {
      // Get Copilot token
      const tokenCtx = toAccountContextFromSnapshot(account, snapshot)
      const { token, refresh_in } = await getCopilotToken(tokenCtx)

      if (!applyCopilotTokenIfCurrent(account, snapshot, token)) {
        return
      }

      // Resolve the account-specific Copilot endpoint before the first models fetch.
      await this.refreshQuota(account)

      // Start token refresh timer
      this.startTokenRefresh(account, refresh_in)

      // Get models
      const modelsCtx = toAccountContextFromSnapshot(account, snapshot, token)
      const models = await getModels(modelsCtx)

      if (!applyModelsIfCurrent(account, snapshot, models)) {
        return
      }
      account.lastModelsFetch = Date.now()

      consola.debug(`Account ${account.id} initialized`)
    } catch (error) {
      // Ignore stale results if registry hot reload changed auth.
      if (!isAuthSnapshotCurrent(account, snapshot)) {
        return
      }

      throw error
    }
  }

  /** Migrate legacy github_token to the new multi-account system. */
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

  /** Start token refresh timer for an account. */
  private startTokenRefresh(
    account: AccountRuntime,
    refreshInSeconds: number,
  ): void {
    // Stop existing timer if any
    this.stopTokenRefresh(account)

    this.tokenRefreshEnabledAccounts.add(account)

    const snapshot = takeAuthSnapshot(account)
    const delayMs = this.computeTokenRefreshDelayMs(refreshInSeconds)

    account.refreshTimer = setTimeout(() => {
      void this.runTokenRefreshTick(account, snapshot, refreshInSeconds)
    }, delayMs)
  }

  /** Stop token refresh timer for an account. */
  private stopTokenRefresh(account: AccountRuntime): void {
    this.tokenRefreshEnabledAccounts.delete(account)

    if (account.refreshTimer) {
      clearTimeout(account.refreshTimer)
      account.refreshTimer = undefined
    }
  }

  /** Stop all token refresh timers. */
  private stopAllTokenRefresh(): void {
    for (const account of this.accounts.values()) {
      this.stopTokenRefresh(account)
    }
    if (this.temporaryAccount) {
      this.stopTokenRefresh(this.temporaryAccount)
    }
  }

  private startSessionRefresh(account: AccountRuntime): void {
    this.stopSessionRefresh(account)

    const delayMs = this.computeSessionRefreshDelayMs()
    consola.debug(
      `Scheduling next VSCode session ID refresh for ${account.id} in ${Math.round(
        delayMs / 1000,
      )} seconds`,
    )

    account.sessionRefreshTimer = setTimeout(() => {
      try {
        account.clientSessionId = createAccountSessionId()
        consola.debug(
          `Refreshed VSCode session ID for account ${account.id}: ${account.clientSessionId}`,
        )
      } catch (error) {
        consola.error(
          `Failed to refresh VSCode session ID for ${account.id}, rescheduling...`,
          error,
        )
      } finally {
        this.startSessionRefresh(account)
      }
    }, delayMs)
  }

  private stopSessionRefresh(account: AccountRuntime): void {
    if (account.sessionRefreshTimer) {
      clearTimeout(account.sessionRefreshTimer)
      account.sessionRefreshTimer = undefined
    }
  }

  private stopAllSessionRefresh(): void {
    for (const account of this.accounts.values()) {
      this.stopSessionRefresh(account)
    }

    if (this.temporaryAccount) {
      this.stopSessionRefresh(this.temporaryAccount)
    }
  }

  private scheduleModelsRefresh(): void {
    this.stopModelsRefresh()

    if (!this.modelsRefreshIntervalMs || this.modelsRefreshIntervalMs <= 0) {
      return
    }

    this.modelsRefreshTimer = setTimeout(() => {
      void this.runModelsRefreshTick()
    }, this.modelsRefreshIntervalMs)
  }

  private stopModelsRefresh(): void {
    if (this.modelsRefreshTimer) {
      clearTimeout(this.modelsRefreshTimer)
      this.modelsRefreshTimer = undefined
    }
  }

  private async runModelsRefreshTick(): Promise<void> {
    try {
      await this.refreshAllModels()
    } catch (error) {
      consola.error("Failed to refresh models:", error)
    } finally {
      this.scheduleModelsRefresh()
    }
  }

  private finalizeModelsRefreshPromise(
    account: AccountRuntime,
    promise: Promise<void>,
  ): void {
    if (account.modelsRefreshPromise !== promise) {
      return
    }

    account.isRefreshingModels = false
    account.modelsRefreshPromise = undefined
    this.modelsRefreshSnapshotByAccount.delete(account)
  }

  private async refreshModels(account: AccountRuntime): Promise<void> {
    if (!account.copilotToken) {
      consola.debug(
        `Skip model refresh for ${account.id}: missing Copilot token`,
      )
      return
    }

    const snapshot = takeAuthSnapshot(account)

    if (account.modelsRefreshPromise) {
      const existingSnapshot = this.modelsRefreshSnapshotByAccount.get(account)
      if (isSameAuthSnapshot(existingSnapshot, snapshot)) {
        await account.modelsRefreshPromise
        return
      }
    }

    account.isRefreshingModels = true

    const ctx = toAccountContextFromSnapshot(
      account,
      snapshot,
      account.copilotToken,
    )

    const promise = (async () => {
      try {
        const models = await getModels(ctx)
        const applied = applyModelsIfCurrent(account, snapshot, models)
        if (applied) {
          account.lastModelsFetch = Date.now()
        }
      } catch (error) {
        if (error instanceof HTTPError && error.response.status === 401) {
          applyUnauthorizedIfCurrent(account, snapshot, "Unauthorized (401)")
          return
        }

        consola.error(`Failed to refresh models for ${account.id}:`, error)
      }
    })()

    account.modelsRefreshPromise = promise
    this.modelsRefreshSnapshotByAccount.set(account, snapshot)

    void promise.finally(() => {
      this.finalizeModelsRefreshPromise(account, promise)
    })

    await promise
  }

  private async refreshAllModels(): Promise<void> {
    const accounts: Array<AccountRuntime> = []

    if (this.temporaryAccount) {
      accounts.push(this.temporaryAccount)
    }

    for (const id of this.accountOrder) {
      const account = this.accounts.get(id)
      if (account) {
        accounts.push(account)
      }
    }

    if (accounts.length === 0) {
      return
    }

    await Promise.allSettled(
      accounts.map((account) => this.refreshModels(account)),
    )
  }

  /** Refresh quota information for an account. */
  async refreshQuota(account: AccountRuntime): Promise<void> {
    const snapshot = takeAuthSnapshot(account)

    if (account.quotaRefreshPromise) {
      const existingSnapshot = this.quotaRefreshSnapshotByAccount.get(account)
      if (isSameAuthSnapshot(existingSnapshot, snapshot)) {
        await account.quotaRefreshPromise
        return
      }
    }

    account.isRefreshingQuota = true

    const ctx = toAccountContextFromSnapshot(account, snapshot)
    const promise = (async () => {
      try {
        const usage = await getCopilotUsage(ctx)
        const premium = usage.quota_snapshots.premium_interactions
        applyQuotaRefreshSuccessIfCurrent(account, snapshot, {
          premium,
          copilotApiUrl: usage.endpoints.api,
        })
      } catch (error) {
        if (error instanceof HTTPError && error.response.status === 401) {
          applyUnauthorizedIfCurrent(account, snapshot, "Unauthorized (401)")
          return
        }

        consola.error(`Failed to refresh quota for ${account.id}:`, error)
        // Don't mark as failed for non-401 quota refresh errors
      }
    })()

    account.quotaRefreshPromise = promise
    this.quotaRefreshSnapshotByAccount.set(account, snapshot)

    void promise.finally(() => {
      this.finalizeQuotaRefreshPromise(account, promise)
    })

    await promise
  }

  /** Check if quota cache is expired. */
  private isQuotaCacheExpired(account: AccountRuntime): boolean {
    if (!account.lastQuotaFetch) return true
    return Date.now() - account.lastQuotaFetch > QUOTA_CACHE_TTL
  }

  private isAccountFailed(account: AccountRuntime): boolean {
    return account.failed === true
  }

  private useOverageFallback(fallback: {
    account: AccountRuntime
    model: Model
    endpoint: string
    costUnits: number
  }): SelectAccountForRequestSuccess {
    const reservation = reservePremiumUnits(
      fallback.account,
      fallback.costUnits,
    )
    return {
      ok: true,
      account: fallback.account,
      selectedModel: fallback.model,
      endpoint: fallback.endpoint,
      costUnits: fallback.costUnits,
      reservation,
    }
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

  private async selectAccountForCandidates(
    orderedAccounts: Array<AccountRuntime>,
    candidates: Array<AccountRequestCandidate>,
  ): Promise<SelectAccountForRequestResult> {
    if (orderedAccounts.length === 0) {
      return { ok: false, reason: "NO_ACCOUNTS" }
    }

    let supportedCandidateFound = false
    let overageFallback:
      | {
          account: AccountRuntime
          model: Model
          endpoint: string
          costUnits: number
        }
      | undefined

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
      const costUnits = getCostUnits(model)

      if (costUnits <= 0) {
        // Free model: sequential routing (first available account).
        // When account affinity is enabled, the caller (selectAccountForRequest)
        // handles cache lookup/write-back; this path only runs on cache miss.
        return {
          ok: true,
          account,
          selectedModel: model,
          endpoint: candidate.endpoint,
          costUnits,
        }
      }

      if (!account.unlimited && this.isQuotaCacheExpired(account)) {
        await this.refreshQuota(account)
      }

      if (this.isAccountFailed(account)) {
        continue
      }

      if (account.unlimited) {
        return {
          ok: true,
          account,
          selectedModel: model,
          endpoint: candidate.endpoint,
          costUnits,
        }
      }

      // Check if account has sufficient quota.
      const effectiveRemaining = getEffectivePremiumRemaining(account)
      if (effectiveRemaining !== undefined && effectiveRemaining < costUnits) {
        // Insufficient quota - store as overage fallback if permitted, but keep
        // looking for accounts with quota to avoid unnecessary overage charges.
        if (account.overagePermitted && !overageFallback) {
          overageFallback = {
            account,
            model,
            endpoint: candidate.endpoint,
            costUnits,
          }
        }
        continue
      }

      const reservation = reservePremiumUnits(account, costUnits)

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

    // No account with quota found - use overage fallback if available.
    return overageFallback ?
        this.useOverageFallback(overageFallback)
      : { ok: false, reason: "NO_QUOTA" }
  }

  /**
   * Try to use a preferred (affinity) account for the request.
   * Returns a successful selection if the account is usable; null otherwise.
   */

  private async tryAffinityAccount(
    preferredAccountId: string,
    orderedAccounts: Array<AccountRuntime>,
    candidates: Array<AccountRequestCandidate>,
  ): Promise<SelectAccountForRequestSuccess | null> {
    const account = isAffinityAccountUsable(preferredAccountId, orderedAccounts)
    if (!account) {
      return null
    }

    // Try original candidates first, then alias-resolved candidates.
    const supported =
      this.pickSupportedCandidate(account, candidates)
      ?? this.pickAliasFallbackCandidate(account, candidates)
    if (!supported) {
      return null
    }

    return this.validateAffinityQuota(account, supported)
  }

  /**
   * Resolve model aliases and try to pick a supported candidate.
   * Returns null if no alias differs or the account doesn't support the alias.
   */
  private pickAliasFallbackCandidate(
    account: AccountRuntime,
    candidates: Array<AccountRequestCandidate>,
  ): { candidate: AccountRequestCandidate; model: Model } | null {
    const aliasCandidates = candidates.map((candidate) => {
      const modelId = resolveModelAlias(candidate.modelId)
      if (modelId === candidate.modelId) return candidate
      return { ...candidate, modelId }
    })
    const aliasChanged = aliasCandidates.some(
      (candidate, index) => candidate.modelId !== candidates[index].modelId,
    )
    if (!aliasChanged) return null

    return this.pickSupportedCandidate(account, aliasCandidates)
  }

  /**
   * Validate quota for an affinity candidate. Free models pass immediately;
   * premium models go through quota refresh / reservation.
   */
  private async validateAffinityQuota(
    account: AccountRuntime,
    supported: { candidate: AccountRequestCandidate; model: Model },
  ): Promise<SelectAccountForRequestSuccess | null> {
    const { candidate, model } = supported
    const costUnits = getCostUnits(model)

    // Free model — no quota checks needed.
    if (costUnits <= 0) {
      return {
        ok: true,
        account,
        selectedModel: model,
        endpoint: candidate.endpoint,
        costUnits,
      }
    }

    // Premium model — validate quota.
    if (!account.unlimited && this.isQuotaCacheExpired(account)) {
      await this.refreshQuota(account)
    }

    if (this.isAccountFailed(account)) {
      return null
    }

    if (account.unlimited) {
      return {
        ok: true,
        account,
        selectedModel: model,
        endpoint: candidate.endpoint,
        costUnits,
      }
    }

    const effectiveRemaining = getEffectivePremiumRemaining(account)
    if (effectiveRemaining !== undefined && effectiveRemaining < costUnits) {
      return null
    }

    const reservation = reservePremiumUnits(account, costUnits)

    return {
      ok: true,
      account,
      selectedModel: model,
      endpoint: candidate.endpoint,
      costUnits,
      reservation,
    }
  }

  /**
   * Select an available account for a specific request (model + endpoint).
   * When account affinity is enabled, routes to the previously successful account
   * for the same affinity key + model combination.
   * Uses reservation to avoid oversubscribing premium quota under concurrency.
   */
  async selectAccountForRequest(
    candidates: Array<AccountRequestCandidate>,
    affinityContext?: AffinityContext,
  ): Promise<SelectAccountForRequestResult> {
    if (candidates.length === 0) {
      throw new Error("selectAccountForRequest requires at least one candidate")
    }

    const orderedAccounts = [
      ...(this.temporaryAccount ? [this.temporaryAccount] : []),
      ...this.accountOrder
        .map((id) => this.accounts.get(id))
        .filter((account): account is AccountRuntime => account !== undefined),
    ]

    // Resolve the affinity key once — reused for both lookup and write-back.
    const affinityKey =
      this.accountAffinityEnabled && affinityContext ?
        extractAffinityKey(affinityContext)
      : undefined

    const modelKey = candidates[0].modelId
    const cacheKey =
      affinityKey ? buildAffinityCacheKey(affinityKey, modelKey) : undefined

    // Step 1: Try the preferred (affinity) account.
    if (cacheKey) {
      const preferredId = this.affinityCache.get(cacheKey)
      if (preferredId) {
        const affinityResult = await this.tryAffinityAccount(
          preferredId,
          orderedAccounts,
          candidates,
        )
        if (affinityResult) {
          affinityResult.affinityHit = true
          affinityResult.affinityCacheKey = cacheKey
          affinityResult.confirmAffinity = () => {
            if (!this.accountAffinityEnabled) return
            this.affinityCache.set(cacheKey, affinityResult.account.id)
          }
          return affinityResult
        }
      }
    }

    // Step 2: Cache miss — rotate accounts for load balancing when affinity is enabled.
    const accountsForSelection =
      this.accountAffinityEnabled && orderedAccounts.length > 1 ?
        this.rotateAccounts(orderedAccounts)
      : orderedAccounts

    const result = await this.selectWithAliasFallback(
      accountsForSelection,
      candidates,
    )

    if (result.ok) {
      this.loadBalanceCursor++
    }

    // Attach confirmAffinity callback so the handler can persist the mapping on success.
    if (result.ok && cacheKey) {
      const successResult = result
      successResult.confirmAffinity = () => {
        if (!this.accountAffinityEnabled) return
        this.affinityCache.set(cacheKey, successResult.account.id)
      }
    }

    return result
  }

  /**
   * Rotate the accounts array by the current load-balance cursor for round-robin distribution.
   * This ensures cache-miss requests are spread across accounts instead of always hitting the first.
   */
  private rotateAccounts(
    accounts: Array<AccountRuntime>,
  ): Array<AccountRuntime> {
    const start = this.loadBalanceCursor % accounts.length
    if (start === 0) return accounts
    return [...accounts.slice(start), ...accounts.slice(0, start)]
  }

  /**
   * Normal account selection with alias fallback.
   * Extracted to keep selectAccountForRequest readable after adding affinity logic.
   */
  private async selectWithAliasFallback(
    orderedAccounts: Array<AccountRuntime>,
    candidates: Array<AccountRequestCandidate>,
  ): Promise<SelectAccountForRequestResult> {
    const primary = await this.selectAccountForCandidates(
      orderedAccounts,
      candidates,
    )
    if (primary.ok || primary.reason !== "MODEL_NOT_SUPPORTED") {
      return primary
    }

    const aliasCandidates = candidates.map((candidate) => {
      const modelId = resolveModelAlias(candidate.modelId)
      if (modelId === candidate.modelId) return candidate
      return { ...candidate, modelId }
    })
    const aliasChanged = aliasCandidates.some(
      (candidate, index) => candidate.modelId !== candidates[index].modelId,
    )
    if (!aliasChanged) {
      return primary
    }

    return this.selectAccountForCandidates(orderedAccounts, aliasCandidates)
  }

  /**
   * Finalize quota after a request completes.
   * This releases any in-flight reservation and refreshes the actual quota from the API.
   */
  async finalizeQuota(
    account: AccountRuntime,
    reservation?: QuotaReservation,
  ): Promise<void> {
    releasePremiumReservation(account, reservation)

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
      setAccountFailedState(account, reason)
      return
    }

    if (this.temporaryAccount && this.temporaryAccount.id === id) {
      setAccountFailedState(this.temporaryAccount, reason)
    }
  }

  /**
   * Get status of all accounts.
   */
  getAccountStatus(): Array<{
    id: string
    entitlement?: number
    remaining?: number
    unlimited?: boolean
    overagePermitted?: boolean
    failed?: boolean
    failureReason?: string
  }> {
    const statuses: Array<{
      id: string
      entitlement?: number
      remaining?: number
      unlimited?: boolean
      overagePermitted?: boolean
      failed?: boolean
      failureReason?: string
    }> = []

    if (this.temporaryAccount) {
      statuses.push({
        id: "(temporary)",
        entitlement: this.temporaryAccount.premiumEntitlement,
        remaining: this.temporaryAccount.premiumRemaining,
        unlimited: this.temporaryAccount.unlimited,
        overagePermitted: this.temporaryAccount.overagePermitted,
        failed: this.temporaryAccount.failed,
        failureReason: this.temporaryAccount.failureReason,
      })
    }

    for (const id of this.accountOrder) {
      const account = this.accounts.get(id)
      if (account) {
        statuses.push({
          id: account.id,
          entitlement: account.premiumEntitlement,
          remaining: account.premiumRemaining,
          unlimited: account.unlimited,
          overagePermitted: account.overagePermitted,
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
    const user = await getGitHubUser({ githubToken, accountType })

    if (this.temporaryAccount) {
      this.stopTokenRefresh(this.temporaryAccount)
      this.stopSessionRefresh(this.temporaryAccount)
    }

    const runtime: AccountRuntime = {
      id: "(temporary)",
      accountLogin: user.login,
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

      // Successful start: reset restart backoff.
      this.registryWatcherRestartDelayMs = WATCHER_RESTART_INITIAL_DELAY_MS
      if (this.registryWatcherRestartTimer) {
        clearTimeout(this.registryWatcherRestartTimer)
        this.registryWatcherRestartTimer = undefined
      }

      // Handle watcher errors (e.g., file deleted)
      this.registryWatcher.on("error", (error) => {
        consola.debug("Registry watcher error:", error)

        const delayMs = this.registryWatcherRestartDelayMs
        this.registryWatcherRestartDelayMs = Math.min(
          this.registryWatcherRestartDelayMs * 2,
          WATCHER_RESTART_MAX_DELAY_MS,
        )

        // Close broken watcher to avoid repeated error events.
        this.stopRegistryWatcher()

        // Try to restart the watcher after a delay (with backoff)
        this.registryWatcherRestartTimer = setTimeout(() => {
          this.registryWatcherRestartTimer = undefined
          this.startRegistryWatcher()
        }, delayMs)

        consola.debug(`Restarting registry watcher in ${delayMs}ms`)
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
   * Adds new accounts, removes deleted ones, and reinitializes existing accounts
   * when token/accountType changes.
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
      const updated: Array<string> = []

      this.removeDeletedAccounts(currentIds, newIds, removed)

      // Add new accounts (newIds - currentIds)
      for (const meta of newMetas) {
        if (!currentIds.has(meta.id)) {
          await this.addNewAccount(meta, added)
        }
      }

      // Update existing accounts when meta/token changed
      await this.reinitializeUpdatedAccounts(newMetas, currentIds, updated)

      // Update accountOrder to reflect new order
      this.accountOrder = newMetas
        .map((m) => m.id)
        .filter((id) => this.accounts.has(id))

      // Reset load-balance cursor on account list/order changes.
      this.loadBalanceCursor = 0

      this.logRegistryReloadChanges(added, removed, updated)
    } catch (error) {
      consola.error("Failed to reload registry:", error)
      this.shutdown()
      process.exit(1)
    } finally {
      this.isReloading = false
    }
  }

  private removeDeletedAccounts(
    currentIds: Set<string>,
    newIds: Set<string>,
    removed: Array<string>,
  ): void {
    for (const id of currentIds) {
      if (!newIds.has(id)) {
        const account = this.accounts.get(id)
        if (!account) {
          continue
        }

        this.stopTokenRefresh(account)
        this.stopSessionRefresh(account)
        this.accounts.delete(id)
        removed.push(id)
      }
    }
  }

  private async reinitializeUpdatedAccounts(
    newMetas: Array<{ id: string; accountType: AccountType; addedAt: number }>,
    currentIds: Set<string>,
    updated: Array<string>,
  ): Promise<void> {
    for (const meta of newMetas) {
      if (!currentIds.has(meta.id)) {
        continue
      }

      const account = this.accounts.get(meta.id)
      if (!account) {
        continue
      }

      const token = await loadAccountToken(meta.id)
      if (!token) {
        consola.warn(`No token found for account ${meta.id}, skipping update`)
        continue
      }

      const accountTypeChanged = account.accountType !== meta.accountType
      const tokenChanged = account.githubToken !== token
      const addedAtChanged = account.addedAt !== meta.addedAt

      // Keep runtime metadata in sync with the registry.
      if (accountTypeChanged) {
        account.accountType = meta.accountType
      }
      if (addedAtChanged) {
        account.addedAt = meta.addedAt
      }
      account.accountLogin = meta.id
      if (tokenChanged) {
        account.githubToken = token
      }

      if (!accountTypeChanged && !tokenChanged) {
        continue
      }

      try {
        await this.initializeAccount(account)
        updated.push(meta.id)
      } catch (error) {
        consola.error(
          `Failed to reinitialize account ${meta.id} after update:`,
          error,
        )
        account.failed = true
        account.failureReason = String(error)
        updated.push(`${meta.id} (failed)`)
      }
    }
  }

  private logRegistryReloadChanges(
    added: Array<string>,
    removed: Array<string>,
    updated: Array<string>,
  ): void {
    if (added.length === 0 && removed.length === 0 && updated.length === 0) {
      return
    }

    const changes: Array<string> = []
    if (added.length > 0) {
      changes.push(`added: ${added.join(", ")}`)
    }
    if (removed.length > 0) {
      changes.push(`removed: ${removed.join(", ")}`)
    }
    if (updated.length > 0) {
      changes.push(`updated: ${updated.join(", ")}`)
    }

    consola.info(
      `Registry reloaded (${changes.join("; ")}). Total: ${this.accounts.size} account(s)`,
    )
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
      accountLogin: meta.id,
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
    if (this.registryWatcherRestartTimer) {
      clearTimeout(this.registryWatcherRestartTimer)
      this.registryWatcherRestartTimer = undefined
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
    this.stopAllSessionRefresh()
    this.stopModelsRefresh()
    this.affinityCache.clear()
    this.loadBalanceCursor = 0
    this.accounts.clear()
    this.accountOrder = []
    this.temporaryAccount = undefined
  }
}

/** Singleton instance of AccountsManager */
export const accountsManager = new AccountsManager()
