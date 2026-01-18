import { expect, test } from "bun:test"
import { Hono } from "hono"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import type { Model } from "~/services/copilot/get-models"

import { accountsManager } from "~/lib/accounts-manager"
import { getSmallModel, mergeConfigWithDefaults } from "~/lib/config"
import { PATHS } from "~/lib/paths"
import { getRequestHistoryStore } from "~/lib/request-history"
import { maybeBlockOriginalModelName } from "~/routes/messages/utils"
import { modelRoutes } from "~/routes/models/route"

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

const buildModel = (id: string): Model => ({
  id,
  name: id,
  vendor: "upstream",
  object: "model",
  preview: false,
  version: "test",
  model_picker_enabled: true,
  capabilities: {
    family: "test",
    limits: {},
    object: "capabilities",
    supports: {},
    tokenizer: "test",
    type: "chat",
  },
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

const getModelIds = async () => {
  const res = await modelRoutes.fetch(new Request("http://local/"))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: Array<{ id: string }> }
  return body.data.map((model) => model.id)
}

const getBlockStatus = async (clientModel: string) => {
  const app = new Hono()
  app.get("/", (c) => {
    const blocked = maybeBlockOriginalModelName({
      c,
      store: getRequestHistoryStore(),
      requestId: randomUUID(),
      startedAtMs: Date.now(),
      method: "GET",
      path: "/",
      streamRequested: false,
      clientModel,
    })
    return blocked ?? c.text("ok")
  })

  const res = await app.fetch(new Request("http://local/"))
  return res.status
}

test("per-alias block overrides global allow", async () => {
  await withConfig(
    {
      modelAliases: {
        fast: { target: "gpt-5-mini", allowOriginal: false },
      },
      allowOriginalModelNamesForAliases: true,
      smallModel: "gpt-5-mini",
    },
    async () => {
      await withMockedModels(async () => {
        const ids = await getModelIds()
        expect(ids).toContain("fast")
        expect(ids).not.toContain("gpt-5-mini")
      })

      expect(getSmallModel()).toBe("fast")
      expect(await getBlockStatus("gpt-5-mini")).toBe(400)
    },
  )
})

test("per-alias allow overrides global block", async () => {
  await withConfig(
    {
      modelAliases: {
        fast: { target: "gpt-5-mini", allowOriginal: true },
      },
      allowOriginalModelNamesForAliases: false,
      smallModel: "gpt-5-mini",
    },
    async () => {
      await withMockedModels(async () => {
        const ids = await getModelIds()
        expect(ids).toContain("fast")
        expect(ids).toContain("gpt-5-mini")
      })

      expect(getSmallModel()).toBe("gpt-5-mini")
      expect(await getBlockStatus("gpt-5-mini")).toBe(200)
    },
  )
})

test("allow-wins when multiple aliases map to the same target", async () => {
  await withConfig(
    {
      modelAliases: {
        fast: { target: "gpt-5-mini", allowOriginal: false },
        rapid: { target: "gpt-5-mini", allowOriginal: true },
      },
      allowOriginalModelNamesForAliases: false,
      smallModel: "gpt-5-mini",
    },
    async () => {
      await withMockedModels(async () => {
        const ids = await getModelIds()
        expect(ids).toContain("fast")
        expect(ids).toContain("rapid")
        expect(ids).toContain("gpt-5-mini")
      })

      expect(getSmallModel()).toBe("gpt-5-mini")
      expect(await getBlockStatus("gpt-5-mini")).toBe(200)
    },
  )
})

test("alias default inherits global block", async () => {
  await withConfig(
    {
      modelAliases: {
        fast: { target: "gpt-5-mini" },
      },
      allowOriginalModelNamesForAliases: false,
      smallModel: "gpt-5-mini",
    },
    async () => {
      await withMockedModels(async () => {
        const ids = await getModelIds()
        expect(ids).toContain("fast")
        expect(ids).not.toContain("gpt-5-mini")
      })

      expect(getSmallModel()).toBe("fast")
      expect(await getBlockStatus("gpt-5-mini")).toBe(400)
    },
  )
})

test("alias default inherits global allow", async () => {
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
        const ids = await getModelIds()
        expect(ids).toContain("fast")
        expect(ids).toContain("gpt-5-mini")
      })

      expect(getSmallModel()).toBe("gpt-5-mini")
      expect(await getBlockStatus("gpt-5-mini")).toBe(200)
    },
  )
})
