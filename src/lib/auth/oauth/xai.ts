import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import type { OAuthCredentials, XaiAuthInfo } from "~/lib/types/oauth"
export type { XaiAuthInfo } from "~/lib/types/oauth"

export const XAI_API_BASE_URL = "https://cli-chat-proxy.grok.com"

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const ISSUER = "https://auth.x.ai/oauth2"
const SCOPE = "openid profile email offline_access grok-cli:access api:access"
const REQUEST_TIMEOUT_MS = 30_000
const POLLING_SAFETY_MARGIN_MS = 3000
const REFRESH_BUFFER_MS = 60_000

const tokenSchema = z.object({
  access_token: z.string().trim().min(1),
  refresh_token: z.string().trim().min(1).optional(),
  id_token: z.string().optional(),
  expires_in: z.number().finite().optional(),
})
const deviceSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url({ protocol: /^https$/u }),
  verification_uri_complete: z.url({ protocol: /^https$/u }).optional(),
  expires_in: z.number().finite().optional(),
  interval: z.number().finite().optional(),
})
const errorSchema = z.object({ error: z.string().optional() })

export type XaiCredentials = OAuthCredentials

export interface LoginXaiOptions {
  onAuth: (info: XaiAuthInfo) => void
  signal?: AbortSignal
}

interface XaiOAuthDependencies {
  fetcher?: (url: string, init: RequestInit) => Promise<Response>
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export class XaiOAuthError extends Error {
  readonly reason: "authorization_expired" | "authorization_denied"

  constructor(reason: XaiOAuthError["reason"]) {
    super(
      reason === "authorization_expired" ?
        "xAI device code expired. Please sign in again."
      : "xAI device authorization was denied.",
    )
    this.name = "XaiOAuthError"
    this.reason = reason
  }
}

function positiveSeconds(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback
}

function tokenCredentials(
  tokens: z.infer<typeof tokenSchema>,
  currentRefreshToken?: string,
): Omit<XaiCredentials, "accountId"> {
  const refreshToken = tokens.refresh_token ?? currentRefreshToken
  if (!refreshToken) {
    throw new Error("xAI token response is missing refresh_token")
  }

  let expiresAt = Date.now() + positiveSeconds(tokens.expires_in, 3600) * 1000
  if (!tokens.expires_in || tokens.expires_in <= 0) {
    try {
      const payload: unknown = JSON.parse(
        Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(
          "utf8",
        ),
      )
      const claims = z
        .object({ exp: z.number().finite().positive() })
        .safeParse(payload)
      if (claims.success) expiresAt = claims.data.exp * 1000
    } catch {
      // Opaque or malformed JWTs use a one-hour fallback lifetime.
    }
  }

  return { accessToken: tokens.access_token, refreshToken, expiresAt }
}

function tokenAccountId(token: string | undefined): string | undefined {
  if (!token) return undefined
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    )
    const claims = z
      .object({ sub: z.string().trim().min(1) })
      .safeParse(payload)
    return claims.success ? claims.data.sub : undefined
  } catch {
    return undefined
  }
}

async function getAccountId(
  tokens: z.infer<typeof tokenSchema>,
  signal: AbortSignal,
  dependencies: XaiOAuthDependencies,
): Promise<string> {
  const accountId =
    tokenAccountId(tokens.id_token) ?? tokenAccountId(tokens.access_token)
  if (accountId) return accountId
  // OIDC userinfo endpoint from auth.x.ai/.well-known/openid-configuration.
  const response = await (dependencies.fetcher ?? fetch)(`${ISSUER}/userinfo`, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  })
  if (!response.ok) throw requestError(response, await readOAuthError(response))
  const user = z
    .object({ sub: z.string().trim().min(1) })
    .parse(await response.json())
  signal.throwIfAborted()
  return user.sub
}

async function send(
  endpoint: "device/code" | "token",
  body: Record<string, string>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
  dependencies: XaiOAuthDependencies = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal =
    options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  try {
    return await (dependencies.fetcher ?? fetch)(`${ISSUER}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "copilot-api",
      },
      body: new URLSearchParams(body),
      signal,
    })
  } catch (error) {
    options.signal?.throwIfAborted()
    if (timeout.aborted) {
      throw new Error(
        `xAI authorization request timed out after ${timeoutMs}ms`,
        { cause: error },
      )
    }
    throw error
  }
}

async function readOAuthError(response: Response): Promise<string | undefined> {
  const payload: unknown = await response.json().catch(() => null)
  const parsed = errorSchema.safeParse(payload)
  return parsed.success ? parsed.data.error : undefined
}

function requestError(response: Response, error?: string): Error {
  // Do not include raw upstream bodies or descriptions that can contain tokens.
  const detail = error && /^[a-z_]+$/u.test(error) ? `: ${error}` : ""
  return new Error(
    `xAI authorization request failed (${response.status})${detail}`,
  )
}

export async function loginXai(
  options: LoginXaiOptions,
  dependencies: XaiOAuthDependencies = {},
): Promise<XaiCredentials> {
  options.signal?.throwIfAborted()
  const response = await send(
    "device/code",
    {
      client_id: CLIENT_ID,
      scope: SCOPE,
      referrer: "opencode",
    },
    options,
    dependencies,
  )
  if (!response.ok) throw requestError(response, await readOAuthError(response))
  const device = deviceSchema.parse(await response.json())
  options.signal?.throwIfAborted()
  const lifetimeMs = positiveSeconds(device.expires_in, 300) * 1000
  const expiresAt = Date.now() + lifetimeMs
  const timeout = AbortSignal.timeout(lifetimeMs)
  const signal =
    options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  options.onAuth({
    url: device.verification_uri_complete ?? device.verification_uri,
    verificationUri: device.verification_uri,
    userCode: device.user_code,
    expiresAt,
  })
  let intervalMs = Math.max(positiveSeconds(device.interval, 5) * 1000, 1000)
  const sleep =
    dependencies.sleep
    ?? ((ms, abortSignal) => delay(ms, undefined, { signal: abortSignal }))

  try {
    for (;;) {
      signal.throwIfAborted()
      const tokenResponse = await send(
        "token",
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: CLIENT_ID,
          device_code: device.device_code,
        },
        { signal },
        dependencies,
      )
      signal.throwIfAborted()
      if (tokenResponse.ok) {
        const tokens = tokenSchema.parse(await tokenResponse.json())
        signal.throwIfAborted()
        const credentials = tokenCredentials(tokens)
        const accountId = await getAccountId(tokens, signal, dependencies)
        signal.throwIfAborted()
        return { ...credentials, accountId }
      }

      const error = await readOAuthError(tokenResponse)
      if (error === "authorization_pending" || error === "slow_down") {
        if (error === "slow_down") intervalMs += 5000
        await sleep(intervalMs + POLLING_SAFETY_MARGIN_MS, signal)
        continue
      }
      if (error === "access_denied" || error === "authorization_denied") {
        throw new XaiOAuthError("authorization_denied")
      }
      if (error === "expired_token")
        throw new XaiOAuthError("authorization_expired")
      throw requestError(tokenResponse, error)
    }
  } catch (error) {
    options.signal?.throwIfAborted()
    if (timeout.aborted) throw new XaiOAuthError("authorization_expired")
    throw error
  }
}

export async function refreshXaiCredentials(
  credentials: XaiCredentials,
  options: { timeoutMs?: number } = {},
  dependencies: XaiOAuthDependencies = {},
): Promise<XaiCredentials> {
  const response = await send(
    "token",
    {
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      client_id: CLIENT_ID,
    },
    options,
    dependencies,
  )
  if (!response.ok) throw requestError(response, await readOAuthError(response))
  const tokens = tokenSchema.parse(await response.json())
  const refreshedAccountId =
    tokenAccountId(tokens.id_token) ?? tokenAccountId(tokens.access_token)
  if (refreshedAccountId && refreshedAccountId !== credentials.accountId)
    throw new Error("xAI token refresh returned a different account")
  return {
    ...tokenCredentials(tokens, credentials.refreshToken),
    accountId: credentials.accountId,
  }
}

export function isXaiCredentialsExpired(
  credentials: Pick<XaiCredentials, "expiresAt">,
  now = Date.now(),
): boolean {
  return credentials.expiresAt <= now + REFRESH_BUFFER_MS
}
