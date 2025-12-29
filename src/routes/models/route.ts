import { Hono } from "hono"

import { accountsManager } from "~/lib/accounts-manager"
import { forwardError } from "~/lib/error"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    const accountModels = accountsManager.getFirstAccountModels()

    const models = accountModels?.data.map((model) => ({
      id: model.id,
      object: "model",
      type: "model",
      created: 0, // No date available from source
      created_at: new Date(0).toISOString(), // No date available from source
      owned_by: model.vendor,
      display_name: model.name,
    }))

    return c.json({
      object: "list",
      data: models ?? [],
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
