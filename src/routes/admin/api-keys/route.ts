import { Hono } from "hono"
import { getConfig } from "~/lib/config"
import { normalizeApiKeyRecords } from "~/lib/config/api-key-config"
import { getApiKeyQuotaUsage } from "~/lib/auth/api-key-quota-runtime"
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
