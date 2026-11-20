import { afterEach, expect, test } from "bun:test"
import consola from "consola"

import { refreshCodexCredentials } from "~/lib/auth/oauth/codex"
import { pollAccessToken } from "~/services/github/poll-access-token"

const originalDebug = consola.debug
const originalFetch = globalThis.fetch

afterEach(() => {
  consola.debug = originalDebug
  globalThis.fetch = originalFetch
})

test("does not log the GitHub OAuth token response", async () => {
  const debugCalls: Array<Array<unknown>> = []
  consola.debug = ((...args: Array<unknown>) => {
    debugCalls.push(args)
  }) as typeof consola.debug
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({
        access_token: "github-access-secret",
        refresh_token: "github-refresh-secret",
        scope: "read:user",
        token_type: "bearer",
      }),
    )) as unknown as typeof fetch

  const accessToken = await pollAccessToken({
    device_code: "device-code",
    expires_in: 900,
    interval: 0,
    user_code: "user-code",
    verification_uri: "https://github.com/login/device",
  })
  const logs = JSON.stringify(debugCalls)

  expect(accessToken).toBe("github-access-secret")
  expect(logs).not.toContain("github-access-secret")
  expect(logs).not.toContain("github-refresh-secret")
})

test("does not include Codex tokens in response validation errors", async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({
        access_token: "codex-access-secret",
        expires_in: "invalid",
        refresh_token: "codex-refresh-secret",
      }),
    )) as unknown as typeof fetch

  let caughtError: unknown
  try {
    await refreshCodexCredentials({
      accessToken: "old-access-token",
      accountId: "account-id",
      expiresAt: 0,
      refreshToken: "old-refresh-token",
    })
  } catch (error) {
    caughtError = error
  }

  expect(caughtError).toBeInstanceOf(TypeError)
  const message = (caughtError as Error).message
  expect(message).toBe("Codex token refresh response missing required fields")
  expect(message).not.toContain("codex-access-secret")
  expect(message).not.toContain("codex-refresh-secret")
})

test("aborts a stalled Codex credential refresh at its deadline", async () => {
  let refreshSignal: AbortSignal | null | undefined
  globalThis.fetch = ((_input, init) => {
    const signal = init?.signal
    refreshSignal = signal
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) {
        reject(new Error("missing refresh signal"))
        return
      }

      const rejectForAbort = () => {
        reject(
          signal.reason instanceof Error ?
            signal.reason
          : new Error("Codex credential refresh aborted"),
        )
      }

      if (signal.aborted) {
        rejectForAbort()
        return
      }

      signal.addEventListener("abort", rejectForAbort, { once: true })
    })
  }) as typeof fetch

  const failure = await refreshCodexCredentials(
    {
      accessToken: "old-access-token",
      accountId: "account-id",
      expiresAt: 0,
      refreshToken: "old-refresh-token",
    },
    { timeoutMs: 10 },
  ).then(
    () => null,
    (error: unknown) => error,
  )

  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe(
    "Codex token refresh timed out after 10ms",
  )
  expect(refreshSignal?.aborted).toBe(true)
})

test("preserves non-timeout Codex refresh failures", async () => {
  const networkError = new Error("network unavailable")
  globalThis.fetch = (() =>
    Promise.reject(networkError)) as unknown as typeof fetch

  const failure = await refreshCodexCredentials({
    accessToken: "old-access-token",
    accountId: "account-id",
    expiresAt: 0,
    refreshToken: "old-refresh-token",
  }).then(
    () => null,
    (error: unknown) => error,
  )

  expect(failure).toBe(networkError)
})
