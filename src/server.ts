import { Hono } from "hono"
import { cors } from "hono/cors"
import { readFileSync } from "node:fs"

import { modelAwareLogger } from "./lib/model-logger"
import { createAuthMiddleware } from "./lib/request-auth"
import { traceIdMiddleware } from "./lib/trace"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { providerMessageRoutes } from "./routes/provider/messages/route"
import { providerModelRoutes } from "./routes/provider/models/route"
import { responsesRoutes } from "./routes/responses/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(traceIdMiddleware)
server.use(modelAwareLogger)
server.use(cors())
server.use(
  "*",
  createAuthMiddleware({
    allowUnauthenticatedPaths: ["/", "/usage-viewer", "/usage-viewer/"],
  }),
)

server.get("/", (c) => c.text("Server running"))
server.get("/usage-viewer", (c) => {
  const usageViewerFileUrl = new URL("../pages/index.html", import.meta.url)
  return c.html(readFileSync(usageViewerFileUrl, "utf8"))
})
server.get("/usage-viewer/", (c) => c.redirect("/usage-viewer", 301))

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)
server.route("/responses", responsesRoutes)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/responses", responsesRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)

// Provider scoped Anthropic-compatible endpoints
server.route("/:provider/v1/messages", providerMessageRoutes)
server.route("/:provider/v1/models", providerModelRoutes)
