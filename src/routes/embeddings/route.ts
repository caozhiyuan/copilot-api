import { Hono } from "hono"

import { accountsManager } from "~/lib/accounts-manager"
import { forwardError } from "~/lib/error"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    // Select an account with available quota
    const account = await accountsManager.selectAccount()
    if (!account) {
      return c.json(
        {
          error: {
            message: "All accounts exhausted. Please try again later.",
            type: "rate_limit_error",
          },
        },
        429,
      )
    }

    const payload = await c.req.json<EmbeddingRequest>()

    try {
      const ctx = {
        githubToken: account.githubToken,
        copilotToken: account.copilotToken,
        accountType: account.accountType,
        vsCodeVersion: account.vsCodeVersion,
      }
      const response = await createEmbeddings(payload, ctx)

      return c.json(response)
    } finally {
      // Refresh quota after request completes
      await accountsManager.finalizeQuota(account)
    }
  } catch (error) {
    return await forwardError(c, error)
  }
})
