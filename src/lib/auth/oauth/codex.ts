import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import type { OAuthCredentials } from "~/lib/types/oauth"

export { CODEX_API_BASE_URL } from "~/services/codex/constants"

const CALLBACK_HOST = "127.0.0.1"
const CALLBACK_PORT = 1455
const CALLBACK_PATH = "/auth/callback"
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`
const SCOPE = "openid profile email offline_access"
const JWT_CLAIM_PATH = "https://api.openai.com/auth"
const REFRESH_BUFFER_MS = 60_000
const CALLBACK_TIMEOUT_MS = 120_000
const REFRESH_TIMEOUT_MS = 30_000

interface TokenSuccessResult {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export interface RefreshCodexCredentialsOptions {
  timeoutMs?: number
}

interface OAuthPageOptions {
  title: string
  heading: string
  message: string
}

export type CodexCredentials = OAuthCredentials

export interface CodexAuthInfo {
  url: string
  instructions?: string
}

export interface LoginCodexOptions {
  onAuth: (info: CodexAuthInfo) => void
  onPrompt: (message: string) => Promise<string>
  onProgress?: (message: string) => void
  signal?: AbortSignal
}

export class CodexOAuthError extends Error {
  readonly reason: "callback_timeout" | "callback_unavailable"

  constructor(reason: CodexOAuthError["reason"]) {
    super(
      reason === "callback_timeout" ?
        "Codex authorization timed out after 2 minutes"
      : "Could not listen for Codex authorization on port 1455",
    )
    this.reason = reason
    this.name = "CodexOAuthError"
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

async function generatePkce(): Promise<{
  verifier: string
  challenge: string
}> {
  const verifierBytes = new Uint8Array(32)
  crypto.getRandomValues(verifierBytes)
  const verifier = base64UrlEncode(verifierBytes)
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  )

  return {
    verifier,
    challenge: base64UrlEncode(new Uint8Array(hashBuffer)),
  }
}

function createState(): string {
  return randomBytes(16).toString("hex")
}

function parseAuthorizationInput(input: string): {
  code?: string
  state?: string
} {
  const value = input.trim()
  if (!value) {
    return {}
  }

  try {
    const url = new URL(value)
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    }
  } catch {
    // Continue and parse it as plain text.
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2)
    return { code, state }
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value)
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    }
  }

  return { code: value }
}

function decodeJwt(accessToken: string): Record<string, unknown> | null {
  try {
    const payload = accessToken.split(".")[1]
    if (!payload) {
      return null
    }
    return JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>
  } catch {
    return null
  }
}

function getAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken)
  if (!payload) {
    return null
  }

  const authPayload = payload[JWT_CLAIM_PATH]
  if (!authPayload || typeof authPayload !== "object") {
    return null
  }

  const accountId = (authPayload as { chatgpt_account_id?: unknown })
    .chatgpt_account_id
  return typeof accountId === "string" && accountId ? accountId : null
}

function renderOAuthPage(options: OAuthPageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.title)}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: #09090b;
      color: #fafafa;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-align: center;
    }
    main {
      max-width: 560px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 28px;
      line-height: 1.15;
    }
    p {
      margin: 0;
      color: #a1a1aa;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(options.heading)}</h1>
    <p>${escapeHtml(options.message)}</p>
  </main>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function renderOAuthSuccessPage(message: string): string {
  return renderOAuthPage({
    title: "Authentication successful",
    heading: "Authentication successful",
    message,
  })
}

function renderOAuthErrorPage(message: string): string {
  return renderOAuthPage({
    title: "Authentication failed",
    heading: "Authentication failed",
    message,
  })
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<TokenSuccessResult> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
    signal,
  })

  if (!response.ok) {
    const details = await response.text().catch(() => "")
    throw new Error(
      `Codex token exchange failed (${response.status}): ${details || response.statusText}`,
    )
  }

  const payload = (await response.json()) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  }

  if (
    typeof payload.access_token !== "string"
    || typeof payload.refresh_token !== "string"
    || typeof payload.expires_in !== "number"
  ) {
    throw new TypeError("Codex token exchange response missing required fields")
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
  }
}

async function refreshAccessToken(
  refreshToken: string,
  options: RefreshCodexCredentialsOptions = {},
): Promise<TokenSuccessResult> {
  const timeoutMs = options.timeoutMs ?? REFRESH_TIMEOUT_MS
  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response

  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
      signal,
    })
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`Codex token refresh timed out after ${timeoutMs}ms`, {
        cause: error,
      })
    }
    throw error
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "")
    throw new Error(
      `Codex token refresh failed (${response.status}): ${details || response.statusText}`,
    )
  }

  const payload = (await response.json()) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  }

  if (
    typeof payload.access_token !== "string"
    || typeof payload.refresh_token !== "string"
    || typeof payload.expires_in !== "number"
  ) {
    throw new TypeError("Codex token refresh response missing required fields")
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
  }
}

async function createAuthorizationFlow(): Promise<{
  verifier: string
  state: string
  url: string
}> {
  const { verifier, challenge } = await generatePkce()
  const state = createState()
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("redirect_uri", REDIRECT_URI)
  url.searchParams.set("scope", SCOPE)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  url.searchParams.set("id_token_add_organizations", "true")
  url.searchParams.set("codex_cli_simplified_flow", "true")
  url.searchParams.set("originator", "copilot-api")

  return { verifier, state, url: url.toString() }
}

async function waitForAuthorizationCode(
  state: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  let resolveCode: ((code: string | null) => void) | undefined
  const waitForCode = new Promise<string | null>((resolve) => {
    resolveCode = resolve
  })

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url || "", "http://localhost")
      if (url.pathname !== CALLBACK_PATH) {
        response.statusCode = 404
        response.setHeader("Content-Type", "text/html; charset=utf-8")
        response.end(renderOAuthErrorPage("Callback route not found."))
        return
      }

      if (url.searchParams.get("state") !== state) {
        response.statusCode = 400
        response.setHeader("Content-Type", "text/html; charset=utf-8")
        response.end(renderOAuthErrorPage("State mismatch."))
        return
      }

      const code = url.searchParams.get("code")
      if (!code) {
        response.statusCode = 400
        response.setHeader("Content-Type", "text/html; charset=utf-8")
        response.end(renderOAuthErrorPage("Missing authorization code."))
        return
      }

      response.statusCode = 200
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(
        renderOAuthSuccessPage(
          "OpenAI Codex authentication completed. You can close this window.",
        ),
      )
      resolveCode?.(code)
    } catch {
      response.statusCode = 500
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(
        renderOAuthErrorPage("Internal error while processing OAuth callback."),
      )
    }
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
        server.off("error", reject)
        resolve()
      })
    })
  } catch {
    throw new CodexOAuthError("callback_unavailable")
  }

  let timeout: ReturnType<typeof setTimeout> | undefined
  const onAbort = () => resolveCode?.(null)
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    signal?.throwIfAborted()
    timeout = setTimeout(() => resolveCode?.(null), CALLBACK_TIMEOUT_MS)
    const code = await waitForCode
    signal?.throwIfAborted()
    if (!code) throw new CodexOAuthError("callback_timeout")
    return code
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", onAbort)
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
      server.closeAllConnections()
    }).catch(() => undefined)
  }
}

export async function loginCodex(
  options: LoginCodexOptions,
): Promise<CodexCredentials> {
  options.signal?.throwIfAborted()
  const { verifier, state, url } = await createAuthorizationFlow()
  options.signal?.throwIfAborted()
  options.onAuth({
    url,
    instructions:
      "Please complete the login in the browser. If the browser does not automatically redirect, please paste the callback URL or code back to the terminal.",
  })
  options.onProgress?.("Waiting for Codex OAuth callback")

  let code: string | null = null
  let callbackError: CodexOAuthError | undefined
  try {
    code = await waitForAuthorizationCode(state, options.signal)
  } catch (error) {
    options.signal?.throwIfAborted()
    if (!(error instanceof CodexOAuthError)) throw error
    callbackError = error
  }
  options.signal?.throwIfAborted()
  if (!code) {
    const input = await options.onPrompt(
      "Paste the authorization code or full redirect URL:",
    )
    options.signal?.throwIfAborted()
    const parsed = parseAuthorizationInput(input)
    if (parsed.state && parsed.state !== state) {
      throw new Error("Codex OAuth state mismatch")
    }
    code = parsed.code ?? null
  }

  if (!code) {
    throw callbackError ?? new Error("Missing Codex authorization code")
  }

  const tokenResult = await exchangeAuthorizationCode(
    code,
    verifier,
    options.signal,
  )
  options.signal?.throwIfAborted()
  const accountId = getAccountId(tokenResult.accessToken)
  if (!accountId) {
    throw new Error("Failed to extract Codex account id from access token")
  }

  return {
    accessToken: tokenResult.accessToken,
    refreshToken: tokenResult.refreshToken,
    expiresAt: tokenResult.expiresAt,
    accountId,
  }
}

export async function refreshCodexCredentials(
  credentials: CodexCredentials,
  options: RefreshCodexCredentialsOptions = {},
): Promise<CodexCredentials> {
  const tokenResult = await refreshAccessToken(
    credentials.refreshToken,
    options,
  )
  const accountId = getAccountId(tokenResult.accessToken)
  if (!accountId) {
    throw new Error("Failed to extract Codex account id from access token")
  }

  return {
    accessToken: tokenResult.accessToken,
    refreshToken: tokenResult.refreshToken,
    expiresAt: tokenResult.expiresAt,
    accountId,
  }
}

export function isCodexCredentialsExpired(
  credentials: Pick<CodexCredentials, "expiresAt">,
  now: number = Date.now(),
): boolean {
  return credentials.expiresAt <= now + REFRESH_BUFFER_MS
}
