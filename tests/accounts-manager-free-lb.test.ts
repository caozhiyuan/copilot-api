import { expect, test } from "bun:test"

import type { AccountRuntime } from "../src/lib/types/account"
import type { Model, ModelsResponse } from "../src/services/copilot/get-models"

import { AccountsManager } from "../src/lib/accounts-manager"

const makeModel = (overrides: Partial<Model> = {}): Model => {
  const base: Model = {
    billing: {
      is_premium: false,
      multiplier: 0,
    },
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

  return {
    ...base,
    ...overrides,
  }
}

const makeModelsResponse = (models: Array<Model>): ModelsResponse => ({
  object: "list",
  data: models,
})

const setupManager = (
  accounts: Array<AccountRuntime>,
  options?: { temporaryAccount?: AccountRuntime },
): AccountsManager => {
  const manager = new AccountsManager()
  const internals = manager as unknown as {
    accounts: Map<string, AccountRuntime>
    accountOrder: Array<string>
    temporaryAccount?: AccountRuntime
  }

  for (const account of accounts) {
    internals.accounts.set(account.id, account)
    internals.accountOrder.push(account.id)
  }

  if (options?.temporaryAccount) {
    internals.temporaryAccount = options.temporaryAccount
  }

  return manager
}

test("selectAccountForRequest round-robins free models across accounts", async () => {
  const model = makeModel({
    id: "free-model",
    billing: {
      is_premium: false,
      multiplier: 0,
    },
  })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }
  const c: AccountRuntime = {
    id: "c",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_c",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a, b, c])

  const seen: Array<string> = []
  for (let i = 0; i < 6; i++) {
    const selection = await manager.selectAccountForRequest([
      { modelId: "free-model", endpoint: "/chat/completions" },
    ])

    expect(selection.ok).toBe(true)
    if (!selection.ok) return

    seen.push(selection.account.id)
    expect(selection.costUnits).toBe(0)
    expect(selection.reservation).toBeUndefined()
  }

  expect(seen).toEqual(["a", "b", "c", "a", "b", "c"])
})

test("selectAccountForRequest includes temporaryAccount in free-model RR", async () => {
  const model = makeModel({ id: "free-model" })

  const temp: AccountRuntime = {
    id: "temp",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_temp",
    models: makeModelsResponse([model]),
  }

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }

  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a, b], { temporaryAccount: temp })

  const seen: Array<string> = []
  for (let i = 0; i < 6; i++) {
    const selection = await manager.selectAccountForRequest([
      { modelId: "free-model", endpoint: "/chat/completions" },
    ])

    expect(selection.ok).toBe(true)
    if (!selection.ok) return

    seen.push(selection.account.id)
  }

  expect(seen).toEqual(["temp", "a", "b", "temp", "a", "b"])
})

test("selectAccountForRequest skips failed accounts in free-model RR", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
    failed: true,
    failureReason: "test",
  }
  const c: AccountRuntime = {
    id: "c",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_c",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a, b, c])

  const seen: Array<string> = []
  for (let i = 0; i < 4; i++) {
    const selection = await manager.selectAccountForRequest([
      { modelId: "free-model", endpoint: "/chat/completions" },
    ])

    expect(selection.ok).toBe(true)
    if (!selection.ok) return

    seen.push(selection.account.id)
  }

  expect(seen).toEqual(["a", "c", "a", "c"])
})

test("selectAccountForRequest keeps premium model selection sequential (no RR)", async () => {
  const premium = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 1,
    },
  })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([premium]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([premium]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([a, b])

  const seen: Array<string> = []
  for (let i = 0; i < 3; i++) {
    const selection = await manager.selectAccountForRequest([
      { modelId: "gpt-5", endpoint: "/chat/completions" },
    ])

    expect(selection.ok).toBe(true)
    if (!selection.ok) return

    seen.push(selection.account.id)
    expect(selection.costUnits).toBe(1)
    expect(selection.reservation).toBeDefined()
  }

  expect(seen).toEqual(["a", "a", "a"])
})

test("free RR does not affect premium selection", async () => {
  const free = makeModel({ id: "free-model" })
  const premium = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 1,
    },
  })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([free, premium]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([free, premium]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([a, b])

  const free1 = await manager.selectAccountForRequest([
    { modelId: "free-model", endpoint: "/chat/completions" },
  ])
  expect(free1.ok).toBe(true)
  if (!free1.ok) return

  const free2 = await manager.selectAccountForRequest([
    { modelId: "free-model", endpoint: "/chat/completions" },
  ])
  expect(free2.ok).toBe(true)
  if (!free2.ok) return

  const premiumSelection = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])
  expect(premiumSelection.ok).toBe(true)
  if (!premiumSelection.ok) return

  expect([free1.account.id, free2.account.id]).toEqual(["a", "b"])
  expect(premiumSelection.account.id).toBe("a")
})

test("selectAccountForRequest routes free models sequentially when freeModelLoadBalancing is disabled", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }

  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }

  const c: AccountRuntime = {
    id: "c",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_c",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a, b, c])
  manager.setFreeModelLoadBalancingEnabled(false)

  const seen: Array<string> = []
  for (let i = 0; i < 3; i++) {
    const selection = await manager.selectAccountForRequest([
      { modelId: "free-model", endpoint: "/chat/completions" },
    ])

    expect(selection.ok).toBe(true)
    if (!selection.ok) return

    seen.push(selection.account.id)
    expect(selection.costUnits).toBe(0)
    expect(selection.reservation).toBeUndefined()
  }

  expect(seen).toEqual(["a", "a", "a"])
})
