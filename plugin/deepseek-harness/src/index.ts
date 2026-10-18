import type {} from "@deepseek-ai/cordis-plugin-loader"
import type {} from "@deepseek-ai/dsh-fs"
import type { Context } from "@deepseek-ai/cordis"
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment"
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from "@deepseek-ai/dsh-llm"
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from "@deepseek-ai/dsh-llm"
import { Config, connectionOf } from "./config.ts"
import { CopilotModelCatalog } from "./catalog.ts"
import { CopilotApiAdapter } from "./provider.ts"

export { Config }
export type { ModelOverride, Protocol, Settings } from "./config.ts"
export const name = "copilot-api-provider"
export const inject = ["llm"]

/** Independent Cordis plugin, reusing the existing Harness runtime and PiAiAdapter. */
export function apply(ctx: Context, references: Config): void {
  const config = { ...references, get modelOverrides() { return references.modelOverrides.get() } }
  const { baseURL, keyRef } = connectionOf(config)
  const settingsNs = ctx.fiber.entry?.options.id ?? name
  const resolveKey = async (): Promise<string> => {
    const credentials = ctx.get("credentials")
    const value = credentials === undefined
      ? launchEnvironmentOf(ctx).get(keyRef)?.value
      : (await credentials.resolve(keyRef))?.value
    if (value === undefined || value.length === 0) {
      throw new LlmError(`copilot-api-provider: store or export the ${keyRef} credential before using this provider`, "MISSING_CREDENTIAL")
    }
    return assertUsableApiKey(value, name, keyRef)
  }
  let registration: AdapterRegistrationHandle | undefined
  let directory: DirectoryRegistrationHandle | undefined
  const directoryEntries = (error?: string): LlmConfigurableProvider[] => [{
    provider: "copilot-api", displayName: "Copilot API", settingsNs, settingsPath: [],
    defaultBaseURL: baseURL, nativeAuth: { env: [keyRef], oauth: false },
    ...error === undefined ? {} : { error },
  }]
  const catalog = new CopilotModelCatalog(config, baseURL, resolveKey, error => {
    directory?.replace(directoryEntries(error))
    registration?.replace(["copilot-api"])
  }, message => ctx.logger.warn(message))
  const adapter = new CopilotApiAdapter(catalog, {
    resolveApiKey: resolveKey,
    resolveAttachments: () => ctx.get("attachments"),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, hostPath => ctx.get("fs")?.processPathFromHostPath(hostPath), ref,
    ),
    onReplayDegrade: () => ctx.logger.warn("copilot-api-provider: unusable assistant replay metadata; using provider-neutral history"),
  }, config.retryPolicy)
  registration = ctx.llm.registerAdapter(["copilot-api"], adapter)
  directory = ctx.llm.registerConfigurableProviders(directoryEntries())
  ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
    // Endpoint/key drafts must not accidentally interrogate the active connection.
    if (request.baseURL !== undefined && connectionOf({ ...config, baseURL: request.baseURL }).baseURL !== baseURL) {
      throw new LlmError("copilot-api-provider: save connection settings before refreshing models", "INVALID_CONFIG")
    }
    if (request.api !== undefined && request.api !== config.protocol) {
      throw new LlmError("copilot-api-provider: save the protocol before refreshing models", "INVALID_CONFIG")
    }
    if (request.provider === "copilot-api") await catalog.ensure(signal)
    else {
      await catalog.refresh(signal)
      signal?.throwIfAborted()
    }
    return (catalog.models ?? []).map(model => ({
      id: model.id, name: model.name, contextWindow: model.contextWindow,
      maxTokens: model.maxTokens, inputModalities: model.input,
    }))
  })
  ctx.effect(() => {
    const refresh = () => { void catalog.refresh().catch(() => { /* The catalog reports this failure once. */ }) }
    refresh()
    const timer = config.modelRefreshInterval === 0 ? undefined : setInterval(refresh, config.modelRefreshInterval)
    timer?.unref()
    let overrides = config.modelOverrides
    const unwatch = ctx.on("loader/volatile-update", () => {
      if (overrides === config.modelOverrides) return
      overrides = config.modelOverrides
      refresh()
    })
    return async () => {
      unwatch()
      clearInterval(timer)
      await catalog.dispose()
    }
  })
}
