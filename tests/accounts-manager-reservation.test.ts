import { expect, test } from "bun:test"

import type { AccountRuntime } from "../src/lib/types/account"
import type { Model, ModelsResponse } from "../src/services/copilot/get-models"

import { AccountsManager } from "../src/lib/accounts-manager"

const makeModel = (overrides: Partial<Model> = {}): Model => {
  const base: Model = {
    billing: {
      is_premium: true,
      multiplier: 1,
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

const setupManagerWithAccount = (account: AccountRuntime): AccountsManager => {
  const manager = new AccountsManager()
  const internals = manager as unknown as {
    accounts: Map<string, AccountRuntime>
    accountOrder: Array<string>
  }
  internals.accounts.set(account.id, account)
  internals.accountOrder.push(account.id)
  return manager
}

test("selectAccountForRequest reserves multiplier units and releases on finalizeQuota", async () => {
  const model = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 2.5,
    },
  })

  const account: AccountRuntime = {
    id: "octocat",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccount(account)

  const selection = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.costUnits).toBe(2.5)
  expect(selection.reservation).toBeDefined()
  expect(account.premiumReserved).toBe(2.5)

  // Avoid network calls from finalizeQuota() in unit test.
  ;(manager as unknown as { refreshQuota: () => Promise<void> }).refreshQuota =
    async () => {}

  await manager.finalizeQuota(account, selection.reservation)

  expect(account.premiumReserved).toBe(0)
  expect(account.premiumReservations).toBeUndefined()
})

test("selectAccountForRequest prevents oversubscription with in-flight reservation", async () => {
  const model = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 1,
    },
  })

  const account: AccountRuntime = {
    id: "octocat",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 1,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccount(account)

  const first = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])
  expect(first.ok).toBe(true)

  const second = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])
  expect(second.ok).toBe(false)
  if (second.ok) return

  expect(second.reason).toBe("NO_QUOTA")
})

test("selectAccountForRequest returns MODEL_NOT_SUPPORTED when endpoint is not supported", async () => {
  const model = makeModel({
    id: "gpt-5",
    supported_endpoints: ["/chat/completions"],
  })

  const account: AccountRuntime = {
    id: "octocat",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccount(account)

  const selection = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/responses" },
  ])

  expect(selection.ok).toBe(false)
  if (selection.ok) return

  expect(selection.reason).toBe("MODEL_NOT_SUPPORTED")
})

test("selectAccountForRequest treats missing billing as free (costUnits=0)", async () => {
  const model = makeModel({
    id: "free-model",
    billing: undefined,
  })

  const account: AccountRuntime = {
    id: "octocat",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 0,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccount(account)

  const selection = await manager.selectAccountForRequest([
    { modelId: "free-model", endpoint: "/chat/completions" },
  ])

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.costUnits).toBe(0)
  expect(selection.reservation).toBeUndefined()
  expect(account.premiumReserved).toBeUndefined()
})
