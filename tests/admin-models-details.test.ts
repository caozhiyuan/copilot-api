import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import type { Model } from "~/services/copilot/get-models"

import { accountsManager } from "~/lib/accounts-manager"
import { mergeConfigWithDefaults } from "~/lib/config"
import { PATHS } from "~/lib/paths"

type ModelsResponse = { data: Array<Model>; object: string }

type ModelAliasSpec = {
  target: string
  allowOriginal?: boolean
}

type TestConfig = {
  modelAliases: Record<string, ModelAliasSpec | string>
  allowOriginalModelNamesForAliases: boolean
  smallModel: string
}

const buildModel = (id: string, overrides?: Partial<Model>): Model => ({
  id,
  name: id,
  vendor: "upstream",
  object: "model",
  preview: false,
  version: "test",
  model_picker_enabled: true,
  capabilities: {
    family: "test",
    limits: {
      max_context_window_tokens: 128_000,
      max_output_tokens: 32_000,
    },
    object: "capabilities",
    supports: {
      tool_calls: true,
      vision: false,
      structured_outputs: true,
      streaming: true,
      parallel_tool_calls: true,
    },
    tokenizer: "test",
    type: "chat",
  },
  billing: {
    multiplier: 1,
    is_premium: false,
  },
  supported_endpoints: ["/responses", "/chat/completions"],
  ...overrides,
})

const withConfig = async (config: TestConfig, run: () => Promise<void>) => {
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
    // eslint-disable-next-line unicorn/prefer-ternary
    if (original === null) {
      await fs.rm(PATHS.CONFIG_PATH, { force: true })
    } else {
      await fs.writeFile(PATHS.CONFIG_PATH, original, "utf8")
    }
    mergeConfigWithDefaults()
  }
}

const withMockedModels = async (run: () => Promise<void>) => {
  const originalGetFirstAccountModels =
    accountsManager.getFirstAccountModels.bind(accountsManager)

  accountsManager.getFirstAccountModels = () =>
    ({
      data: [buildModel("gpt-5-mini"), buildModel("gpt-4")],
      object: "list",
    }) as ModelsResponse

  try {
    await run()
  } finally {
    // eslint-disable-next-line require-atomic-updates
    accountsManager.getFirstAccountModels = originalGetFirstAccountModels
  }
}

test("GET /api/admin/models/details returns model details with aliases", async () => {
  await withConfig(
    {
      modelAliases: {
        fast: { target: "gpt-5-mini" },
      },
      allowOriginalModelNamesForAliases: true,
      smallModel: "gpt-5-mini",
    },
    async () => {
      await withMockedModels(async () => {
        const { server } = await import("../src/server")
        const res = await server.fetch(
          new Request("http://localhost/api/admin/models/details"),
        )

        expect(res.status).toBe(200)

        const body = (await res.json()) as {
          items: Array<{
            id: string
            name: string
            aliases: Array<string>
            supported_endpoints?: Array<string>
            billing?: { multiplier?: number }
            capabilities: {
              limits: {
                max_context_window_tokens?: number
                max_output_tokens?: number
              }
              supports: { tool_calls?: boolean }
            }
          }>
        }

        // Stable ordering by id.
        expect(body.items.map((m) => m.id)).toEqual(["gpt-4", "gpt-5-mini"])

        const mini = body.items.find((m) => m.id === "gpt-5-mini")
        expect(mini).toBeTruthy()
        expect(mini?.aliases).toEqual(["fast"])
        expect(mini?.supported_endpoints).toEqual([
          "/responses",
          "/chat/completions",
        ])
        expect(mini?.billing?.multiplier).toBe(1)
        expect(mini?.capabilities.limits.max_context_window_tokens).toBe(
          128_000,
        )
        expect(mini?.capabilities.supports.tool_calls).toBe(true)
      })
    },
  )
})
