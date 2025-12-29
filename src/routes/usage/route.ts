import { Hono } from "hono"

import { accountsManager } from "~/lib/accounts-manager"

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
