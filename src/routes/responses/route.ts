import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleCompletion } from "./handler"

export const responseRoutes = new Hono()

responseRoutes.post("/", async (c) => {
  try {
    return await handleCompletion(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
