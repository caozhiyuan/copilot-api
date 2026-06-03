import { Hono } from "hono"
import { z } from "zod"

import { forwardError } from "~/lib/error"
import {
  getModelMappings,
  getModelOverrides,
  setModelMappings,
  setModelOverrides,
} from "~/lib/config"
import { PATHS } from "~/lib/paths"

export const configRoutes = new Hono()

const modelMappingsRequestSchema = z.object({
  modelMappings: z.record(z.string(), z.string()),
})

const modelOverridesRequestSchema = z.object({
  modelOverrides: z.record(
    z.string().min(1),
    z.record(z.string(), z.unknown()),
  ),
})

configRoutes.get("/model-mappings", (c) => {
  return c.json({
    configPath: PATHS.CONFIG_PATH,
    modelMappings: getModelMappings(),
  })
})

configRoutes.post("/model-mappings", async (c) => {
  try {
    const parseResult = modelMappingsRequestSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const updatedModelMappings = setModelMappings(
      parseResult.data.modelMappings,
    )

    return c.json({
      configPath: PATHS.CONFIG_PATH,
      modelMappings: updatedModelMappings,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.get("/model-overrides", (c) => {
  return c.json({
    configPath: PATHS.CONFIG_PATH,
    modelOverrides: getModelOverrides(),
  })
})

configRoutes.post("/model-overrides", async (c) => {
  try {
    const parseResult = modelOverridesRequestSchema.safeParse(
      await c.req.json(),
    )
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const updatedModelOverrides = setModelOverrides(
      parseResult.data.modelOverrides,
    )

    return c.json({
      configPath: PATHS.CONFIG_PATH,
      modelOverrides: updatedModelOverrides,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
