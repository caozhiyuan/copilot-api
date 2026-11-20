import { Hono } from "hono"

import { isClaudeUserAgent } from "~/lib/catalog/claude-models"
import { forwardError } from "~/lib/http/error"
import { handleClaudeModels } from "~/routes/models/claude-models"
import {
  handleCodexModels,
  isCodexUserAgent,
} from "~/routes/models/codex-models"
import { handleDefaultModels } from "~/routes/models/default-models"
import {
  handleOpencodeModels,
  isOpencodeUserAgent,
} from "~/routes/models/opencode-models"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    const userAgent = c.req.header("user-agent")
    if (isOpencodeUserAgent(userAgent)) return await handleOpencodeModels(c)
    if (isCodexUserAgent(userAgent)) return await handleCodexModels(c)
    if (isClaudeUserAgent(userAgent)) return await handleClaudeModels(c)
    return await handleDefaultModels(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
