import { beforeEach, describe, expect, mock, test } from "bun:test"

import type { ResolvedProviderConfig } from "~/lib/config"

const actualConfigModule = await import("~/lib/config")

let azureModuleImports = 0
let credentialInstances = 0
let tokenProviderFactories = 0
let entraToken = "entra-access-token"
let entraFailure: Error | null = null

const entraProviderConfig: ResolvedProviderConfig = {
  apiKey: "",
  authType: "azure-entra",
  baseUrl: "https://example.openai.azure.com/openai",
  name: "foundry",
  type: "openai-compatible",
}

const basicProviderConfig: ResolvedProviderConfig = {
  apiKey: "basic-key",
  authType: "x-api-key",
  baseUrl: "https://example.com",
  name: "basic",
  type: "anthropic",
}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: (name: string) => {
    if (name === "foundry") {
      return entraProviderConfig
    }
    if (name === "basic") {
      return basicProviderConfig
    }
    return null
  },
}))

await mock.module("@azure/identity", () => {
  azureModuleImports += 1
  return {
    DefaultAzureCredential: class {
      constructor() {
        credentialInstances += 1
      }
    },
    getBearerTokenProvider: (_credential: unknown, _scope: unknown) => {
      tokenProviderFactories += 1
      return () => {
        if (entraFailure) {
          throw entraFailure
        }
        return Promise.resolve(entraToken)
      }
    },
  }
})

const { resolveProviderConfig } = await import(
  "~/lib/providers/provider-resolver"
)

const credentialInstancesAfterImport = credentialInstances
const tokenProviderFactoriesAfterImport = tokenProviderFactories

beforeEach(() => {
  entraToken = "entra-access-token"
  entraFailure = null
})

describe("provider resolver azure-entra", () => {
  test("does not touch @azure/identity for non-entra providers", async () => {
    expect(credentialInstancesAfterImport).toBe(0)
    expect(tokenProviderFactoriesAfterImport).toBe(0)

    expect(await resolveProviderConfig("basic")).toEqual(basicProviderConfig)
    expect(await resolveProviderConfig("missing")).toBeNull()
    expect(await resolveProviderConfig("   ")).toBeNull()

    expect(credentialInstances).toBe(0)
    expect(tokenProviderFactories).toBe(0)
    expect(azureModuleImports).toBe(0)
  })

  test("reuses a single credential across entra resolutions", async () => {
    const first = await resolveProviderConfig("foundry")
    const second = await resolveProviderConfig("foundry")

    expect(first).toMatchObject({
      apiKey: "entra-access-token",
      authType: "azure-entra",
      name: "foundry",
    })
    expect(second).toMatchObject({ apiKey: "entra-access-token" })
    expect(credentialInstances).toBe(1)
    expect(tokenProviderFactories).toBe(1)
    expect(azureModuleImports).toBe(1)
  })

  test("wraps entra token failures with the provider name", async () => {
    const failure = new Error("az login session expired")
    entraFailure = failure

    let error: unknown = null
    try {
      await resolveProviderConfig("foundry")
    } catch (resolveError) {
      error = resolveError
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      "Failed to acquire Azure Entra token for provider 'foundry': az login session expired",
    )
    expect((error as Error).cause).toBe(failure)
  })
})
