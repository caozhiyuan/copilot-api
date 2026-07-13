import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { readFileSync } from "node:fs"

import {
  createAuthMiddleware,
  getConfiguredAdminApiKeys,
} from "./lib/request-auth"
import { traceIdMiddleware } from "./lib/trace"
import { zstdDecompressionMiddleware } from "./lib/zstd-request"
import { alphaSearchRoutes } from "./routes/alpha-search/route"
import { completionRoutes } from "./routes/chat-completions/route"
import { configRoutes } from "./routes/admin/config/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { providerImageRoutes } from "./routes/provider/images/route"
import { providerMessageRoutes } from "./routes/provider/messages/route"
import { providerModelRoutes } from "./routes/provider/models/route"
import { responsesRoutes } from "./routes/responses/route"
import { tokenUsageRoute } from "./routes/token-usage/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(traceIdMiddleware)
server.use(logger())
server.use(cors())
server.use(
  "*",
  createAuthMiddleware({
    allowUnauthenticatedPaths: ["/", "/usage-viewer", "/usage-viewer/"],
    shouldSkipPath: (path) => path.startsWith("/admin/"),
  }),
)
server.use(
  "/admin/*",
  createAuthMiddleware({
    getApiKeys: getConfiguredAdminApiKeys,
    allowUnauthenticatedPaths: [],
    allowWhenNoApiKeys: false,
  }),
)
server.use(zstdDecompressionMiddleware)

server.get("/", (c) => c.text("Server running"))
server.get("/usage-viewer", (c) => {
  const usageViewerFileUrl = new URL("../pages/index.html", import.meta.url)
  return c.html(readFileSync(usageViewerFileUrl, "utf8"))
})
server.get("/usage-viewer/", (c) => c.redirect("/usage-viewer", 301))

server.route("/chat/completions", completionRoutes)
server.route("/admin/config", configRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token-usage", tokenUsageRoute)
server.route("/token", tokenRoute)
server.route("/responses", responsesRoutes)
server.route("/alpha/search", alphaSearchRoutes)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/responses", responsesRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)

// Provider-scoped endpoints
server.route("/:provider/v1/messages", providerMessageRoutes)
server.route("/:provider/v1/models", providerModelRoutes)
server.route("/:provider/v1/images", providerImageRoutes)
