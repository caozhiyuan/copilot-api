import { Hono } from "hono"

import { handleImages } from "~/routes/images/handler"

export const imageRoutes = new Hono()

export { imageRouteDependencies } from "~/routes/images/shared"

imageRoutes.post("/generations", (c) => handleImages(c, "generations"))
imageRoutes.post("/edits", (c) => handleImages(c, "edits"))
