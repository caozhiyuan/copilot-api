import { Hono } from "hono"
import { getConfig } from "~/lib/config"
import { normalizeApiKeyRecords } from "~/lib/api-key-config"
import { getApiKeyQuotaUsage } from "~/lib/token-usage/store"
import type { ApiKeyQuotaUsage } from "~/lib/types/api-key"

export const apiKeyUsageRoutes = new Hono()
apiKeyUsageRoutes.get("/", async (c) => {
  const keys = normalizeApiKeyRecords(getConfig().auth?.apiKeyConfigs)
  const usage: Array<ApiKeyQuotaUsage> = await Promise.all(
    keys.map(async (key) => ({
      id: key.id,
      ...(await getApiKeyQuotaUsage(key)),
    })),
  )
  return c.json(usage)
})
