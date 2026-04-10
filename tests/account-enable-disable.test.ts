import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"

import type { AccountRuntime } from "../src/lib/types/account"
import type { Model, ModelsResponse } from "../src/services/copilot/get-models"

import { AccountsManager } from "../src/lib/accounts-manager"
import { isAccountEnabled, loadRegistry } from "../src/lib/accounts-registry"

// ---------------------------------------------------------------------------
// isAccountEnabled unit tests
// ---------------------------------------------------------------------------

describe("isAccountEnabled", () => {
  test("returns true when enabled is undefined (backward compatible)", () => {
    expect(
      isAccountEnabled({ id: "a", accountType: "individual", addedAt: 1 }),
    ).toBe(true)
  })

  test("returns true when enabled is true", () => {
    expect(
      isAccountEnabled({
        id: "a",
        accountType: "individual",
        addedAt: 1,
        enabled: true,
      }),
    ).toBe(true)
  })

  test("returns false when enabled is false", () => {
    expect(
      isAccountEnabled({
        id: "a",
        accountType: "individual",
        addedAt: 1,
        enabled: false,
      }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// loadRegistry accepts enabled field
// ---------------------------------------------------------------------------

type ReadFile = typeof fs.readFile

const withMockedReadFile = async <T>(
  impl: ReadFile,
  run: () => Promise<T>,
): Promise<T> => {
  const original = fs.readFile
  ;(fs as unknown as { readFile: ReadFile }).readFile = impl
  try {
    return await run()
  } finally {
    ;(fs as unknown as { readFile: ReadFile }).readFile = original
  }
}

describe("loadRegistry with enabled field", () => {
  test("parses v2 registry with enabled=false without error", async () => {
    const content = JSON.stringify({
      version: 2,
      accounts: [
        { id: "octocat", accountType: "individual", addedAt: 1, enabled: false },
      ],
      clientIdentities: {},
    })

    const registry = await withMockedReadFile(
      (() => content) as unknown as ReadFile,
      loadRegistry,
    )

    expect(registry.accounts[0].enabled).toBe(false)
  })

  test("parses v2 registry with enabled=true", async () => {
    const content = JSON.stringify({
      version: 2,
      accounts: [
        { id: "octocat", accountType: "individual", addedAt: 1, enabled: true },
      ],
      clientIdentities: {},
    })

    const registry = await withMockedReadFile(
      (() => content) as unknown as ReadFile,
      loadRegistry,
    )

    expect(registry.accounts[0].enabled).toBe(true)
  })

  test("parses v2 registry with enabled omitted (undefined)", async () => {
    const content = JSON.stringify({
      version: 2,
      accounts: [
        { id: "octocat", accountType: "individual", addedAt: 1 },
      ],
      clientIdentities: {},
    })

    const registry = await withMockedReadFile(
      (() => content) as unknown as ReadFile,
      loadRegistry,
    )

    expect(registry.accounts[0].enabled).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// selectAccountForRequest skips disabled accounts
// ---------------------------------------------------------------------------

const makeModel = (overrides: Partial<Model> = {}): Model => {
  const base: Model = {
    billing: { is_premium: false, multiplier: 1 },
    capabilities: {
      family: "test",
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "test",
      type: "test",
    },
    id: "test-model",
    model_picker_enabled: true,
    name: "Test model",
    object: "model",
    preview: false,
    supported_endpoints: ["/chat/completions"],
    vendor: "test",
    version: "0",
  }
  return { ...base, ...overrides }
}

const makeModelsResponse = (models: Array<Model>): ModelsResponse => ({
  object: "list",
  data: models,
})

const setupManagerWithAccounts = (
  accounts: Array<AccountRuntime>,
): AccountsManager => {
  const manager = new AccountsManager()
  const internals = manager as unknown as {
    accounts: Map<string, AccountRuntime>
    accountOrder: Array<string>
  }
  for (const account of accounts) {
    internals.accounts.set(account.id, account)
    internals.accountOrder.push(account.id)
  }
  return manager
}

describe("selectAccountForRequest with disabled accounts", () => {
  const model = makeModel({ id: "gpt-4o-mini" })

  test("skips disabled accounts and selects enabled one", async () => {
    const disabledAccount: AccountRuntime = {
      id: "disabled-user",
      accountType: "individual",
      addedAt: Date.now(),
      githubToken: "ghp_disabled",
      vsCodeVersion: "1.0.0",
      models: makeModelsResponse([model]),
      enabled: false,
    }

    const enabledAccount: AccountRuntime = {
      id: "enabled-user",
      accountType: "individual",
      addedAt: Date.now(),
      githubToken: "ghp_enabled",
      vsCodeVersion: "1.0.0",
      models: makeModelsResponse([model]),
    }

    const manager = setupManagerWithAccounts([disabledAccount, enabledAccount])
    const selection = await manager.selectAccountForRequest([
      { modelId: "gpt-4o-mini", endpoint: "/chat/completions" },
    ])

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.account.id).toBe("enabled-user")
  })

  test("returns error when all accounts are disabled", async () => {
    const account1: AccountRuntime = {
      id: "user-a",
      accountType: "individual",
      addedAt: Date.now(),
      githubToken: "ghp_a",
      vsCodeVersion: "1.0.0",
      models: makeModelsResponse([model]),
      enabled: false,
    }

    const account2: AccountRuntime = {
      id: "user-b",
      accountType: "individual",
      addedAt: Date.now(),
      githubToken: "ghp_b",
      vsCodeVersion: "1.0.0",
      models: makeModelsResponse([model]),
      enabled: false,
    }

    const manager = setupManagerWithAccounts([account1, account2])
    const selection = await manager.selectAccountForRequest([
      { modelId: "gpt-4o-mini", endpoint: "/chat/completions" },
    ])

    expect(selection.ok).toBe(false)
  })

  test("selects enabled account with enabled: true explicitly set", async () => {
    const account: AccountRuntime = {
      id: "explicit-enabled",
      accountType: "individual",
      addedAt: Date.now(),
      githubToken: "ghp_test",
      vsCodeVersion: "1.0.0",
      models: makeModelsResponse([model]),
      enabled: true,
    }

    const manager = setupManagerWithAccounts([account])
    const selection = await manager.selectAccountForRequest([
      { modelId: "gpt-4o-mini", endpoint: "/chat/completions" },
    ])

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.account.id).toBe("explicit-enabled")
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/admin/accounts/:id integration tests
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/accounts/:id", () => {
  test("returns 400 for non-boolean enabled value", async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/accounts/octocat", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: "yes" }),
      }),
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBeDefined()
  })

  test("returns 400 for missing enabled field", async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/accounts/octocat", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    )

    expect(res.status).toBe(400)
  })

  test("returns 400 for invalid JSON body", async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/accounts/octocat", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
    )

    expect(res.status).toBe(400)
  })

  test("returns 404 for non-existent account", async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request(
        "http://localhost/api/admin/accounts/nonexistent-user-xyz",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      ),
    )

    expect(res.status).toBe(404)
  })
})
