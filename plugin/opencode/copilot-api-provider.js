const providerID = "local"
const responsesPackage = "@opencode/ai/providers/openai/responses"

// Single-file plugin for OpenCode's v2 branch; no imports or dependencies.
export default {
  id: "local.provider",
  async setup(ctx) {
    const options = ctx.options ?? {}
    const baseURL = (
      options.baseURL
      ?? process.env.COPILOT_API_URL
      ?? "http://localhost:4141/v1"
    ).replace(/\/+$/u, "")
    const apiKey = options.apiKey ?? process.env.GITHUB_COPILOT_API_KEY ?? "dummy"
    const refreshIntervalMs = options.refreshIntervalMs ?? 120_000
    const loadModels = async () => {
      const response = await fetch(`${baseURL}/models`, {
        headers: {
          "user-agent": "opencode/copilot-api-provider",
          "x-api-key": apiKey,
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        throw new Error(`Model discovery failed: HTTP ${response.status}`)
      }
      const body = await response.json()
      if (
        !Array.isArray(body?.data)
        || !body.data.every((model) =>
          typeof model?.id === "string"
          && typeof model?.modelID === "string"
          && model?.capabilities
          && Array.isArray(model?.cost),
        )
      ) {
        throw new Error("Invalid OpenCode v2 model catalog")
      }
      return body.data.map((model) => ({
        ...model,
        providerID,
        package: model.package ?? responsesPackage,
      }))
    }
    const reportError = (error) =>
      console.warn("copilot-api model discovery:", error?.message ?? error)
    let models = await loadModels().catch((error) => {
      reportError(error)
      return []
    })
    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          id: providerID,
          name: "My Local",
          activation: "enabled",
          package: responsesPackage,
          settings: { baseURL, apiKey, compaction: { type: "native" } },
        },
        models,
      })
    })
    if (refreshIntervalMs <= 0) return
    let stopped = false
    let refreshing = false
    const refresh = async () => {
      if (stopped || refreshing) return
      refreshing = true
      try {
        const next = await loadModels()
        if (stopped) return
        models = next
        await ctx.provider.reload()
      } finally {
        refreshing = false
      }
    }
    const timer = setInterval(
      () => void refresh().catch(reportError),
      refreshIntervalMs,
    )
    return () => {
      stopped = true
      clearInterval(timer)
    }
  },
}
