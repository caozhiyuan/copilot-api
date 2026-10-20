import { Hono } from "hono"

import { handleImagesEdits } from "~/routes/images/edits-handler"
import { handleImagesGenerations } from "~/routes/images/generations-handler"

export const imageRoutes = new Hono()

// Re-exported for the provider-scoped images routes and tests.
export {
  handleCodexImages,
  imageRouteDependencies,
} from "~/routes/images/shared"

imageRoutes.post("/generations", handleImagesGenerations)
imageRoutes.post("/edits", handleImagesEdits)
