// src/routes/admin-api/auth-sessions.ts
import { randomUUID } from "node:crypto"
import consola from "consola"

import {
  addAccountToRegistry,
  listAccountsFromRegistry,
  loadRegistry,
  saveAccountToken,
  saveRegistry,
} from "~/lib/accounts-registry"
import { normalizeDomain } from "~/lib/api-config"
import { ensurePaths } from "~/lib/paths"
import type { AccountType } from "~/lib/types/account"
import { getDeviceCode, type DeviceCodeResponse } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

export type AuthSessionStatus = "pending" | "completed" | "failed" | "expired"

export interface AuthSession {
  sessionId: string
  accountType: AccountType
  enterpriseDomain: string | null
  status: AuthSessionStatus
  userCode: string
  verificationUri: string
  expiresAt: number
  interval: number
  accountId?: string
  error?: string
  abortController: AbortController
  /** The account ID being re-authenticated (null for new accounts) */
  reauthAccountId: string | null
}

export interface StartAuthResult {
  sessionId: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

function buildOauthUrls(enterpriseDomain: string | null) {
  if (!enterpriseDomain) return undefined
  const domain = normalizeDomain(enterpriseDomain)
  if (!domain) return undefined
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
  }
}

const CLEANUP_INTERVAL_MS = 60_000

export class AuthSessionManager {
  private sessions = new Map<string, AuthSession>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  start(): void {
    if (this.cleanupTimer) return
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS)
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    for (const session of this.sessions.values()) {
      session.abortController.abort()
    }
    this.sessions.clear()
  }

  async startAuth(params: {
    accountType: AccountType
    enterpriseDomain?: string
    reauthAccountId?: string
  }): Promise<StartAuthResult> {
    const enterpriseDomain = params.enterpriseDomain
      ? normalizeDomain(params.enterpriseDomain)
      : null

    const overrideUrls = buildOauthUrls(enterpriseDomain)

    await ensurePaths()
    const deviceResponse = await getDeviceCode({ overrideUrls })

    const sessionId = randomUUID()
    const abortController = new AbortController()
    const expiresAt = Date.now() + deviceResponse.expires_in * 1000

    const session: AuthSession = {
      sessionId,
      accountType: params.accountType,
      enterpriseDomain,
      status: "pending",
      userCode: deviceResponse.user_code,
      verificationUri: deviceResponse.verification_uri,
      expiresAt,
      interval: deviceResponse.interval,
      abortController,
      reauthAccountId: params.reauthAccountId ?? null,
    }

    this.sessions.set(sessionId, session)

    // Start background polling (fire and forget)
    void this.runAuthFlow(session, deviceResponse, overrideUrls)

    return {
      sessionId,
      userCode: deviceResponse.user_code,
      verificationUri: deviceResponse.verification_uri,
      expiresIn: deviceResponse.expires_in,
      interval: deviceResponse.interval,
    }
  }

  getStatus(sessionId: string): {
    status: AuthSessionStatus
    accountId?: string
    error?: string
  } | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null

    // Check if expired
    if (session.status === "pending" && Date.now() >= session.expiresAt) {
      session.status = "expired"
      session.abortController.abort()
    }

    return {
      status: session.status,
      accountId: session.accountId,
      error: session.error,
    }
  }

  cancel(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    session.abortController.abort()
    this.sessions.delete(sessionId)
    return true
  }

  private async runAuthFlow(
    session: AuthSession,
    deviceResponse: DeviceCodeResponse,
    overrideUrls: ReturnType<typeof buildOauthUrls>,
  ): Promise<void> {
    try {
      const token = await pollAccessToken(deviceResponse, {
        overrideUrls,
        signal: session.abortController.signal,
      })

      const user = await getGitHubUser({
        githubToken: token,
        accountType: session.accountType,
      })

      const accountId = user.login

      // For reauth: check if the authenticated user matches
      if (session.reauthAccountId && session.reauthAccountId !== accountId) {
        session.status = "failed"
        session.error = `Authenticated as "${accountId}" but expected "${session.reauthAccountId}". Use "Add Account" to add a different account.`
        return
      }

      // Save token
      await saveAccountToken(accountId, token)

      // Check if account already exists in registry
      const existingAccounts = await listAccountsFromRegistry()
      const alreadyExists = existingAccounts.some((acc) => acc.id === accountId)

      if (alreadyExists) {
        // Touch registry to trigger hot-reload
        await saveRegistry(await loadRegistry())
      } else {
        await addAccountToRegistry({
          id: accountId,
          accountType: session.accountType,
          addedAt: Date.now(),
        })
      }

      session.status = "completed"
      session.accountId = accountId
    } catch (error) {
      if (session.abortController.signal.aborted) {
        // Cancelled — don't update status (session may already be removed)
        return
      }

      session.status = "failed"
      session.error = error instanceof Error ? error.message : String(error)
      consola.error(`Auth session ${session.sessionId} failed:`, error)
    }
  }

  private cleanupExpired(): void {
    const now = Date.now()
    // Clean up sessions that expired more than 5 minutes ago
    const cleanupThreshold = 5 * 60_000

    for (const [id, session] of this.sessions) {
      if (session.status !== "pending" && now - session.expiresAt > cleanupThreshold) {
        session.abortController.abort()
        this.sessions.delete(id)
      }
      if (session.status === "pending" && now >= session.expiresAt) {
        session.status = "expired"
        session.abortController.abort()
      }
    }
  }
}

export const authSessionManager = new AuthSessionManager()
