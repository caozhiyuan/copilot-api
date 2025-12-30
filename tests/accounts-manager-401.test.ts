import { expect, mock, test } from "bun:test"

import type { AccountRuntime } from "../src/lib/types/account"

import { AccountsManager } from "../src/lib/accounts-manager"

test("refreshQuota marks account failed on 401", async () => {
  const fetchHolder = globalThis as unknown as { fetch: typeof fetch }
  const originalFetch = fetchHolder.fetch

  const fetchMock = mock(() => new Response("unauthorized", { status: 401 }))
  // @ts-expect-error - mock doesn't implement full fetch signature
  fetchHolder.fetch = fetchMock

  try {
    const manager = new AccountsManager()

    const account: AccountRuntime = {
      id: "octocat",
      accountType: "individual",
      addedAt: Date.now(),
      githubToken: "ghp_test",
      vsCodeVersion: "1.0.0",
    }

    const { accounts } = manager as unknown as {
      accounts: Map<string, AccountRuntime>
    }
    accounts.set(account.id, account)

    await manager.refreshQuota(account)

    expect(account.failed).toBe(true)
    expect(account.failureReason).toBe("Unauthorized (401)")
  } finally {
    fetchHolder.fetch = originalFetch
  }
})

test("refreshQuota ignores stale 401 when githubToken changes before request resolves", async () => {
  const fetchHolder = globalThis as unknown as { fetch: typeof fetch }
  const originalFetch = fetchHolder.fetch

  let resolveFetch: ((value: Response) => void) | undefined
  const deferred = new Promise<Response>((resolve) => {
    resolveFetch = resolve
  })

  const fetchMock = mock(() => deferred)
  // @ts-expect-error - mock doesn't implement full fetch signature
  fetchHolder.fetch = fetchMock

  try {
    const manager = new AccountsManager()

    const account: AccountRuntime = {
      id: "octocat",
      accountType: "individual",
      addedAt: Date.now(),
      githubToken: "ghp_old",
      vsCodeVersion: "1.0.0",
    }

    const { accounts } = manager as unknown as {
      accounts: Map<string, AccountRuntime>
    }
    accounts.set(account.id, account)

    const refreshPromise = manager.refreshQuota(account)

    // Simulate registry hot reload changing the token while the request is in flight.
    account.githubToken = "ghp_new"

    resolveFetch?.(new Response("unauthorized", { status: 401 }))

    await refreshPromise

    expect(account.failed).toBeUndefined()
    expect(account.failureReason).toBeUndefined()
  } finally {
    fetchHolder.fetch = originalFetch
  }
})
