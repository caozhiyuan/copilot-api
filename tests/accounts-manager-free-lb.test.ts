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

// ---------------------------------------------------------------------------
// Load-balanced selection (affinity enabled, cache miss → round-robin)
// ---------------------------------------------------------------------------

test("selectAccountForRequest round-robins free models on cache miss", async () => {
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

  // Round-robin across accounts on cache miss.
  expect(seen).toEqual(["a", "b", "c", "a", "b", "c"])
})

test("selectAccountForRequest starts with temporaryAccount then round-robins", async () => {
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
  for (let i = 0; i < 3; i++) {
    const selection = await manager.selectAccountForRequest([
      { modelId: "free-model", endpoint: "/chat/completions" },
    ])

    expect(selection.ok).toBe(true)
    if (!selection.ok) return

    seen.push(selection.account.id)
  }

  // temporaryAccount is first; round-robin rotates through all.
  expect(seen).toEqual(["temp", "a", "b"])
})

test("selectAccountForRequest skips failed accounts for free models", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
    failed: true,
    failureReason: "test",
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
  for (let i = 0; i < 3; i++) {
    const selection = await manager.selectAccountForRequest([
      { modelId: "free-model", endpoint: "/chat/completions" },
    ])

    expect(selection.ok).toBe(true)
    if (!selection.ok) return

    seen.push(selection.account.id)
  }

  // Account "a" is failed; round-robin rotates across "b" and "c".
  expect(seen).toEqual(["b", "b", "c"])
})

test("selectAccountForRequest round-robins premium models on cache miss", async () => {
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

  // Round-robin distributes premium requests across accounts with quota.
  expect(seen).toEqual(["a", "b", "a"])
})

test("free and premium selection both use round-robin routing", async () => {
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

  // Round-robin: free1 → a (cursor 0), free2 → b (cursor 1), premium → a (cursor 2).
  expect(free1.account.id).toBe("a")
  expect(free2.account.id).toBe("b")
  expect(premiumSelection.account.id).toBe("a")
})

test("selectAccountForRequest routes free models sequentially when accountAffinity is disabled", async () => {
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
  manager.setAccountAffinityEnabled(false)

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

// ---------------------------------------------------------------------------
// Affinity: confirmAffinity causes sticky routing
// ---------------------------------------------------------------------------

test("affinity: confirmAffinity routes subsequent requests to the same account", async () => {
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

  const manager = setupManager([a, b])

  // First request: sequential → account "a". Confirm affinity.
  const first = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-1" },
  )
  expect(first.ok).toBe(true)
  if (!first.ok) return
  expect(first.account.id).toBe("a")
  first.confirmAffinity?.()

  // Second request with same key: affinity cache hit → same account.
  const second = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-1" },
  )
  expect(second.ok).toBe(true)
  if (!second.ok) return
  expect(second.account.id).toBe("a")
})

test("affinity: without confirmAffinity, cache is not populated", async () => {
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

  const manager = setupManager([a, b])

  // First request — do NOT call confirmAffinity.
  const first = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-2" },
  )
  expect(first.ok).toBe(true)
  if (!first.ok) return
  expect(first.confirmAffinity).toBeDefined()
  // intentionally not calling confirmAffinity

  // Second request: cache miss → round-robin advances cursor → "b".
  const second = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-2" },
  )
  expect(second.ok).toBe(true)
  if (!second.ok) return
  // Without confirmAffinity, no cache entry; round-robin picks next account.
  expect(second.account.id).toBe("b")
})

test("affinity: different models with same key can route to different accounts", async () => {
  const modelA = makeModel({
    id: "model-a",
    supported_endpoints: ["/chat/completions"],
  })
  const modelB = makeModel({
    id: "model-b",
    supported_endpoints: ["/chat/completions"],
  })

  const x: AccountRuntime = {
    id: "x",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_x",
    models: makeModelsResponse([modelA]),
  }
  const y: AccountRuntime = {
    id: "y",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_y",
    models: makeModelsResponse([modelB]),
  }

  const manager = setupManager([x, y])

  const selA = await manager.selectAccountForRequest(
    [{ modelId: "model-a", endpoint: "/chat/completions" }],
    { requestId: "shared-key" },
  )
  expect(selA.ok).toBe(true)
  if (!selA.ok) return
  selA.confirmAffinity?.()

  const selB = await manager.selectAccountForRequest(
    [{ modelId: "model-b", endpoint: "/chat/completions" }],
    { requestId: "shared-key" },
  )
  expect(selB.ok).toBe(true)
  if (!selB.ok) return
  selB.confirmAffinity?.()

  // Different models → different cache keys → independent routing.
  expect(selA.account.id).toBe("x")
  expect(selB.account.id).toBe("y")
})

test("affinity: affinityModelId shares stickiness across different candidate models", async () => {
  const bigModel = makeModel({
    id: "big-model",
    supported_endpoints: ["/chat/completions"],
  })
  const smallModel = makeModel({
    id: "small-model",
    supported_endpoints: ["/chat/completions"],
  })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([bigModel, smallModel]),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([bigModel, smallModel]),
  }

  const manager = setupManager([a, b])

  const first = await manager.selectAccountForRequest(
    [{ modelId: "small-model", endpoint: "/chat/completions" }],
    { requestId: "shared-key", affinityModelId: "big-model" },
  )
  expect(first.ok).toBe(true)
  if (!first.ok) return
  expect(first.account.id).toBe("a")
  first.confirmAffinity?.()

  const second = await manager.selectAccountForRequest(
    [{ modelId: "big-model", endpoint: "/chat/completions" }],
    { requestId: "shared-key" },
  )
  expect(second.ok).toBe(true)
  if (!second.ok) return

  expect(second.account.id).toBe("a")
  expect(second.affinityHit).toBe(true)
  expect(second.affinityCacheKey).toBe("shared-key:big-model")
})

test("affinity: skips failed preferred account and falls back to sequential", async () => {
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

  const manager = setupManager([a, b])

  // Establish affinity to account "a".
  const first = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-3" },
  )
  expect(first.ok).toBe(true)
  if (!first.ok) return
  first.confirmAffinity?.()
  expect(first.account.id).toBe("a")

  // Mark "a" as failed.
  a.failed = true
  a.failureReason = "test"

  // Next request: affinity points to "a" but it's failed → fallback to "b".
  const second = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-3" },
  )
  expect(second.ok).toBe(true)
  if (!second.ok) return
  expect(second.account.id).toBe("b")
})

test("affinity: no affinity context uses round-robin", async () => {
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

  const manager = setupManager([a, b])

  // No affinity context → round-robin across accounts.
  const seen: Array<string> = []
  for (let i = 0; i < 3; i++) {
    const selection = await manager.selectAccountForRequest([
      { modelId: "free-model", endpoint: "/chat/completions" },
    ])
    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    seen.push(selection.account.id)
    expect(selection.confirmAffinity).toBeUndefined()
  }
  expect(seen).toEqual(["a", "b", "a"])
})

test("affinity: disabled → no confirmAffinity callback even with context", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a])
  manager.setAccountAffinityEnabled(false)

  const selection = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-x" },
  )
  expect(selection.ok).toBe(true)
  if (!selection.ok) return
  expect(selection.confirmAffinity).toBeUndefined()
})
