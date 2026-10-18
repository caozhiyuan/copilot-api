import React from "react"
import type { Context } from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/dsh-client-locale/client"
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client"
import type { LlmDiscoveredModel, RemoteResult } from "@deepseek-ai/dsh-api-remotes/client"
import type { ProviderCardExtrasOwnerProps } from "@deepseek-ai/dsh-client-ui-settings-models/client"
import type { UseResource } from "@deepseek-ai/dsh-client-resources/client"

const h = React.createElement
const namespace = "copilot-api-provider"
const en = {
  title: "Discovered models", loading: "Loading models…", empty: "No models advertised.",
  model: "Model", input: "Input", capacity: "Context / output", efforts: "Thinking levels",
  text: "Text", image: "Image", unknown: "Not advertised", refresh: "Refresh models",
  apiKey: "API key", saveKey: "Save API key", savedKey: "API key saved securely.",
  hint: "Thinking levels are available in the conversation model selector.",
}
type CopyKey = keyof typeof en
interface DisplayModel extends LlmDiscoveredModel { readonly efforts: readonly string[] }
interface ModelCardInjected {
  t: (key: CopyKey) => string
  refresh: (settingsNs: string, baseURL?: string) => Promise<string | undefined>
  storeKey: (ref: string, value: string) => Promise<string | undefined>
}
type ModelCardProps = ProviderCardExtrasOwnerProps & ModelCardInjected & { useResource: UseResource }

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap { "copilot-api-provider": CopyKey }
  interface ResourceProtocolMap { "copilot-api-models": readonly DisplayModel[] }
}
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface RemoteErrorDetailsMap { "copilot-api/catalog": Record<string, never> }
}

const zh: Record<CopyKey, string> = {
  title: "自动发现的模型", loading: "正在加载模型…", empty: "尚未发现模型。",
  model: "模型", input: "输入", capacity: "上下文 / 输出", efforts: "思考等级",
  text: "文本", image: "图片", unknown: "未声明", refresh: "刷新模型",
  apiKey: "API 密钥", saveKey: "保存 API 密钥", savedKey: "API 密钥已安全保存。",
  hint: "可在对话的模型选择器中选择下列思考等级。",
}

function ModelCard({ provider, useResource, t, refresh, storeKey }: ModelCardProps): React.ReactElement {
  const state = useResource<"copilot-api-models">(`dsh-resource://copilot-api-models/${encodeURIComponent(provider.settingsNs)}`)
  const [failure, setFailure] = React.useState<string | undefined>()
  const [busy, setBusy] = React.useState(false)
  const [key, setKey] = React.useState("")
  const [saved, setSaved] = React.useState(false)
  const keyRef = provider.nativeAuth?.env?.[0]
  const models = state.value ?? []
  return h("section", { "aria-label": t("title"), style: { overflowX: "auto", paddingBlock: "12px" } },
    h("h3", null, t("title")),
    h("p", null, t("hint")),
    keyRef === undefined ? null : h("form", { onSubmit: async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setBusy(true)
      setSaved(false)
      setFailure(undefined)
      try {
        const failure = await storeKey(keyRef, key)
        setFailure(failure)
        setSaved(failure === undefined)
      } finally { setKey(""); setBusy(false) }
    } },
    h("label", null, t("apiKey"), " ", h("input", {
      type: "password", autoComplete: "new-password", value: key, disabled: busy,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setKey(event.target.value),
    })), " ", h("button", { type: "submit", disabled: busy || key.length === 0 }, t("saveKey"))),
    saved ? h("p", { role: "status" }, t("savedKey")) : null,
    h("button", { type: "button", disabled: busy, onClick: async () => {
      setBusy(true)
      setFailure(undefined)
      try { setFailure(await refresh(provider.settingsNs, provider.defaultBaseURL)) }
      finally { setBusy(false) }
    } }, t("refresh")),
    failure || state.failure ? h("p", { role: "alert" }, failure ?? state.failure?.message) : null,
    state.value === undefined ? h("p", { role: "status" }, t("loading"))
      : models.length === 0 ? h("p", null, t("empty"))
        : h("table", { style: { width: "100%", textAlign: "start", borderSpacing: "8px" } },
          h("thead", null, h("tr", null, ...(["model", "input", "capacity", "efforts"] as const).map(key => h("th", { key }, t(key))))),
          h("tbody", null, ...models.map(model => h("tr", { key: model.id },
            h("td", null, h("div", null, model.name), h("code", null, model.id)),
            h("td", null, (model.inputModalities ?? []).map(value => t(value)).join(", ")),
            h("td", null, `${model.contextWindow} / ${model.maxTokens}`),
            h("td", null, model.efforts.length === 0 ? t("unknown") : model.efforts.join(", ")),
          ))),
        ),
  )
}

async function readModels(ctx: Context, settingsNs: string): Promise<RemoteResult<readonly DisplayModel[]>> {
  const [discovery, catalog] = await Promise.all([
    ctx.remote.llm.discoverModels(settingsNs, { provider: "copilot-api" }),
    ctx.remote.session.modelCatalog(),
  ])
  if (!discovery.ok) return discovery
  if (!catalog.ok) return catalog
  const selectable = catalog.value.groups.find(group => group.id === "copilot-api")
  const failure = catalog.value.failures.find(group => group.id === "copilot-api")
  if (failure) return { ok: false, error: Object.assign(new Error(failure.message), {
    name: "RemoteError", code: "copilot-api/catalog" as const, details: {}, isDSHRemoteError: true as const,
  }) }
  return { ok: true, value: discovery.value.map(model => ({
    ...model,
    efforts: selectable?.models.find(item => item.id === model.id)?.reasoning?.efforts.map(effort => effort.id) ?? [],
  })) }
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(namespace, { en, zh }))
  ctx.effect(() => ctx.resources.register({
    protocol: "copilot-api-models",
    async *open(address, { signal }) {
      const settingsNs = decodeURIComponent(new URL(address).pathname.slice(1))
      let pending = true
      let wake: (() => void) | undefined
      const changed = () => { pending = true; wake?.() }
      const disposers = [
        ctx.remote.$on("llm/adapters-updated", changed),
        ctx.remote.$on("credentials/reference-updated", changed),
        ctx.on("connection/reset", changed),
      ]
      signal.addEventListener("abort", changed, { once: true })
      try {
        while (!signal.aborted) {
          if (!pending) await new Promise<void>(resolve => { wake = resolve })
          if (signal.aborted) break
          pending = false
          yield await readModels(ctx, settingsNs)
        }
      } finally {
        signal.removeEventListener("abort", changed)
        for (const dispose of disposers) dispose()
      }
    },
  }))
  ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({
    name: "settings.models.provider-card", key: namespace,
    inject: (): ModelCardInjected => ({
      t: ctx.locale.bind(namespace),
      refresh: async (settingsNs, baseURL) => {
        const result = await ctx.remote.llm.discoverModels(settingsNs, baseURL === undefined ? {} : { baseURL })
        return result.ok ? undefined : result.error.message
      },
      storeKey: async (ref, value) => {
        const result = await ctx.remote.credentials.set(ref, value)
        return result.ok ? undefined : result.error.message
      },
    }),
  }, ModelCard))
}

export const inject = ["slots", "locale", "resources", "remote.llm", "remote.session", "remote.credentials"]
