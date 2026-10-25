import { Hono } from "hono"

import { getCopilotUsage } from "~/services/github/get-copilot-usage"
import { getSubscriptionUsage } from "~/services/subscription-usage"

export const usageRoute = new Hono()

usageRoute.get("/:provider", async (c) => {
  const provider = c.req.param("provider")
  c.header("Cache-Control", "no-store")
  if (
    provider !== "codex"
    && provider !== "xai"
    && provider !== "github-copilot"
    && provider !== "opencode-go"
  ) {
    return c.json({ error: "Unsupported subscription provider" }, 404)
  }
  try {
    const usage = await getSubscriptionUsage(provider, c.req.raw.signal)
    return usage ?
        c.json(usage)
      : c.json({ error: "Subscription account is not available" }, 404)
  } catch {
    return c.json({ error: "Failed to fetch subscription usage" }, 502)
  }
})

usageRoute.get("/", async (c) => {
  try {
    const usage = await getCopilotUsage()
    return c.json(usage)
  } catch (error) {
    console.error("Error fetching Copilot usage:", error)
    return c.json({ error: "Failed to fetch Copilot usage" }, 500)
  }
})
