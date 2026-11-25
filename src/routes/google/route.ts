import { Hono } from "hono"

import { forwardError } from "~/lib/http/error"

import { handleGoogleGenerateContent, handleGoogleModelsList } from "./handler"

export const googleRoutes = new Hono()

googleRoutes.get("/", async (c) => {
  try {
    return await handleGoogleModelsList(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})

googleRoutes.post("/*", async (c) => {
  try {
    return await handleGoogleGenerateContent(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
