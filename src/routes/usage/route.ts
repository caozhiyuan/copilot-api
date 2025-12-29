import { Hono } from "hono"

import { accountsManager } from "~/lib/accounts-manager"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

export const usageRoute = new Hono()

usageRoute.get("/", (c) => {
  try {
    const accountStatuses = accountsManager.getAccountStatus()
    return c.json({
      accounts: accountStatuses,
    })
  } catch (error) {
    console.error("Error fetching account status:", error)
    return c.json({ error: "Failed to fetch account status" }, 500)
  }
})

/**
 * Get detailed usage information for a specific account by index.
 * Index 0 is the temporary account (if exists), otherwise the first registered account.
 */
usageRoute.get("/:accountIndex", async (c) => {
  try {
    const indexParam = c.req.param("accountIndex")
    const index = Number.parseInt(indexParam, 10)

    if (Number.isNaN(index) || index < 0) {
      return c.json({ error: "Invalid account index" }, 400)
    }

    const accountContext = accountsManager.getAccountContextByIndex(index)

    if (!accountContext) {
      const accountCount = accountsManager.getAccountCount()
      return c.json(
        {
          error: `Account index ${index} not found`,
          availableIndices: accountCount > 0 ? `0-${accountCount - 1}` : "none",
        },
        404,
      )
    }

    const usage = await getCopilotUsage(accountContext)

    return c.json(usage)
  } catch (error) {
    console.error("Error fetching account usage:", error)
    return c.json({ error: "Failed to fetch account usage" }, 500)
  }
})
