import { Hono } from "hono"

import { accountsManager } from "~/lib/accounts-manager"
import { forwardError, HTTPError } from "~/lib/error"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

const EMBEDDINGS_ENDPOINT = "/embeddings"

embeddingRoutes.post("/", async (c) => {
  try {
    const payload = await c.req.json<EmbeddingRequest>()

    const selection = await accountsManager.selectAccountForRequest([
      {
        modelId: payload.model,
        endpoint: EMBEDDINGS_ENDPOINT,
      },
    ])

    if (!selection.ok) {
      if (selection.reason === "MODEL_NOT_SUPPORTED") {
        return c.json(
          {
            error: {
              message: `Model "${payload.model}" is not available for any configured account.`,
              type: "invalid_request_error",
            },
          },
          400,
        )
      }

      return c.json(
        {
          error: {
            message:
              "All accounts have exhausted their quota. Please wait for quota refresh or add additional accounts.",
            type: "rate_limit_error",
          },
        },
        429,
      )
    }

    const { account, reservation } = selection

    try {
      const ctx = {
        githubToken: account.githubToken,
        copilotToken: account.copilotToken,
        accountType: account.accountType,
        vsCodeVersion: account.vsCodeVersion,
      }
      const response = await createEmbeddings(payload, ctx)

      return c.json(response)
    } catch (error) {
      if (error instanceof HTTPError && error.response.status === 401) {
        accountsManager.markAccountFailed(account.id, "Unauthorized (401)")
      }
      throw error
    } finally {
      // Refresh quota after request completes
      await accountsManager.finalizeQuota(account, reservation)
    }
  } catch (error) {
    return await forwardError(c, error)
  }
})
