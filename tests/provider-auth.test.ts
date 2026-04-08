import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import {
  getProviderConfig,
  mergeConfigWithDefaults,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { PATHS } from "~/lib/paths"

import { buildProviderUpstreamHeaders } from "../src/services/providers/anthropic-proxy"

function createProviderConfig(
  overrides: Partial<ResolvedProviderConfig> = {},
): ResolvedProviderConfig {
  return {
    name: "custom",
    type: "anthropic",
    baseUrl: "https://example.com",
    apiKey: "provider-key",
    authType: "x-api-key",
    ...overrides,
  }
}

async function withConfig(
  config: Record<string, unknown>,
  run: () => void | Promise<void>,
): Promise<void> {
  const original = await fs
    .readFile(PATHS.CONFIG_PATH, "utf8")
    .catch(() => null)

  await fs.mkdir(path.dirname(PATHS.CONFIG_PATH), { recursive: true })
  await fs.writeFile(
    PATHS.CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
  mergeConfigWithDefaults()

  try {
    await run()
  } finally {
    const restoreConfig =
      original === null ?
        fs.rm(PATHS.CONFIG_PATH, { force: true })
      : fs.writeFile(PATHS.CONFIG_PATH, original, "utf8")
    await restoreConfig
    mergeConfigWithDefaults()
  }
}

describe("getProviderConfig", () => {
  test("defaults authType to x-api-key when omitted", async () => {
    await withConfig(
      {
        providers: {
          custom: {
            type: "anthropic",
            enabled: true,
            baseUrl: "https://example.com",
            apiKey: "provider-key",
          },
        },
      },
      () => {
        expect(getProviderConfig("custom")).toEqual({
          name: "custom",
          type: "anthropic",
          baseUrl: "https://example.com",
          apiKey: "provider-key",
          authType: "x-api-key",
          adjustInputTokens: undefined,
          models: undefined,
        })
      },
    )
  })

  test("returns null for invalid authType", async () => {
    await withConfig(
      {
        providers: {
          custom: {
            type: "anthropic",
            enabled: true,
            baseUrl: "https://example.com",
            apiKey: "provider-key",
            authType: "cookie",
          },
        },
      },
      () => {
        expect(getProviderConfig("custom")).toBeNull()
      },
    )
  })
})

describe("buildProviderUpstreamHeaders", () => {
  test("uses x-api-key auth by default", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig(),
      new Headers({
        accept: "application/json",
        "anthropic-version": "2023-06-01",
      }),
    )

    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": "provider-key",
      "anthropic-version": "2023-06-01",
    })
  })

  test("uses Authorization bearer auth when configured", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({ authType: "authorization" }),
      new Headers({
        accept: "application/json",
        "user-agent": "test-client",
      }),
    )

    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
      "user-agent": "test-client",
    })
  })
})
