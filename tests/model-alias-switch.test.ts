import { expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs/promises"
import path from "node:path"

import type { Model } from "~/services/copilot/get-models"

import { accountsManager } from "~/lib/accounts-manager"
import { getSmallModel, mergeConfigWithDefaults } from "~/lib/config"
import { PATHS } from "~/lib/paths"
import { getRequestHistoryStore } from "~/lib/request-history"
import { maybeBlockOriginalModelName } from "~/routes/messages/utils"
import { modelRoutes } from "~/routes/models/route"

type ModelsResponse = { data: Array<Model> }

type TestConfig = {
  modelAliases: Record<string, string>
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

test("alias-only blocks original model names and hides them from /models", async () => {
  await withConfig(
    {
      modelAliases: {
        fast: "gpt-5-mini",
      },
      allowOriginalModelNamesForAliases: false,
      smallModel: "gpt-5-mini",
    },
    async () => {
      const originalGetFirstAccountModels =
        accountsManager.getFirstAccountModels.bind(accountsManager)
      accountsManager.getFirstAccountModels = () =>
        ({
          data: [buildModel("gpt-5-mini"), buildModel("gpt-4")],
        }) as ModelsResponse

      try {
        const res = await modelRoutes.fetch(new Request("http://local/"))
        expect(res.status).toBe(200)
        const body = (await res.json()) as { data: Array<{ id: string }> }
        const ids = body.data.map((model) => model.id)
        expect(ids).toContain("fast")
        expect(ids).not.toContain("gpt-5-mini")
      } finally {
        // eslint-disable-next-line require-atomic-updates
        accountsManager.getFirstAccountModels = originalGetFirstAccountModels
      }

      expect(getSmallModel()).toBe("fast")

      const app = new Hono()
      app.get("/", (c) => {
        const blocked = maybeBlockOriginalModelName({
          c,
          store: getRequestHistoryStore(),
          requestId: "req-1",
          startedAtMs: Date.now(),
          method: "GET",
          path: "/",
          streamRequested: false,
          clientModel: "gpt-5-mini",
        })
        return blocked ?? c.text("ok")
      })

      const blockedRes = await app.fetch(new Request("http://local/"))
      expect(blockedRes.status).toBe(400)
    },
  )
})
