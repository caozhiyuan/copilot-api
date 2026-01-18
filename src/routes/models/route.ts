import { Hono } from "hono"

import { accountsManager } from "~/lib/accounts-manager"
import { getAliasTargetSet, getModelAliases } from "~/lib/config"
import { forwardError } from "~/lib/error"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    const accountModels = accountsManager.getFirstAccountModels()

    const blockedTargets = getAliasTargetSet()
    const models =
      accountModels?.data
        .filter((model) => !blockedTargets.has(model.id.toLowerCase()))
        .map((model) => ({
          id: model.id,
          object: "model",
          type: "model",
          created: 0, // No date available from source
          created_at: new Date(0).toISOString(), // No date available from source
          owned_by: model.vendor,
          display_name: model.name,
        })) ?? []

    const aliasItems = Object.keys(getModelAliases())
    const aliasModels = aliasItems.map((alias) => ({
      id: alias,
      object: "model",
      type: "model",
      created: 0,
      created_at: new Date(0).toISOString(),
      owned_by: "alias",
      display_name: alias,
    }))

    const merged = new Map<string, (typeof models)[number]>()
    for (const model of models) {
      merged.set(model.id, model)
    }
    for (const model of aliasModels) {
      if (!merged.has(model.id)) {
        merged.set(model.id, model)
      }
    }

    return c.json({
      object: "list",
      data: Array.from(merged.values()),
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
