// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"

let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = undefined
  vi.unstubAllGlobals()
})

async function browser(built = false) {
  let plugin
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  window.__ModuleLoader__ = { load(module) { plugin = module.factory(id => {
    if (id !== "react") throw new Error(`Unexpected browser dependency: ${id}`)
    return React
  }) } }
  vi.resetModules()
  if (built) await import("../dist/client.js")
  else plugin = await import("../src/client/index.ts")
  let resource, seat, Component, dictionaries
  const dispose = []
  const listeners = new Map()
  const subscribe = (event, listener) => {
    const set = listeners.get(event) ?? new Set()
    set.add(listener)
    listeners.set(event, set)
    return () => set.delete(listener)
  }
  const model = { id: "codex/gpt-gateway", name: "Gateway model", inputModalities: ["text", "image"], contextWindow: 128000, maxTokens: 16000 }
  const ctx = {
    effect: callback => { dispose.push(callback()) },
    on: subscribe,
    locale: {
      register: (ns, value) => { dictionaries = value; return () => {} },
      bind: () => key => dictionaries.en[key],
    },
    resources: { register: value => { resource = value; return () => {} } },
    slots: {
      inject: (name, callback) => callback(),
      register: (config, component) => { seat = config; Component = component; return () => {} },
    },
    remote: {
      $on: subscribe,
      credentials: { set: vi.fn(async () => ({ ok: true })) },
      llm: { discoverModels: vi.fn(async () => ({ ok: true, value: [model] })) },
      session: { modelCatalog: vi.fn(async () => ({ ok: true, value: { groups: [{
        id: "copilot-api", models: [{ id: model.id, reasoning: { efforts: [{ id: "high" }, { id: "max" }] } }],
      }], failures: [] } })) },
    },
  }
  plugin.apply(ctx)
  return { ctx, resource, seat, Component, dictionaries, listeners, dispose, model,
    emit: event => { for (const listener of listeners.get(event) ?? []) listener() },
  }
}

it("loads the compiled Harness browser factory using only shared React", async () => {
  const { resource, seat, Component } = await browser(true)
  expect(seat).toMatchObject({ name: "settings.models.provider-card", key: "copilot-api-provider" })
  expect(typeof Component).toBe("function")
  const controller = new AbortController()
  const stream = resource.open("dsh-resource://copilot-api-models/copilot-api-provider", { signal: controller.signal })
  expect((await stream.next()).value).toMatchObject({ ok: true, value: [{ efforts: ["high", "max"] }] })
  controller.abort()
  expect((await stream.next()).done).toBe(true)
})

it("registers a normal provider-card slot and displays the actual selector efforts and image capability", async () => {
  const { resource, seat, Component, dictionaries, ctx } = await browser()
  expect(seat).toMatchObject({ name: "settings.models.provider-card", key: "copilot-api-provider" })
  expect(dictionaries.zh.image).toBe("图片")
  const controller = new AbortController()
  const stream = resource.open("dsh-resource://copilot-api-models/copilot-api-provider", { signal: controller.signal })
  const first = (await stream.next()).value
  expect(first).toMatchObject({ ok: true, value: [{ efforts: ["high", "max"], inputModalities: ["text", "image"] }] })
  const node = document.createElement("div")
  root = createRoot(node)
  const injected = seat.inject()
  await act(async () => root?.render(React.createElement(Component, {
    ...injected, provider: { settingsNs: "copilot-api-provider", defaultBaseURL: "http://localhost:4141/v1" },
    useResource: () => ({ status: "live", value: first.value }),
  })))
  expect(node.textContent).toContain("high, max")
  expect(node.textContent).toContain("Image")
  expect(node.textContent).toContain("codex/gpt-gateway")
  expect(node.textContent).toContain("128000 / 16000")
  await act(async () => node.querySelector("button")?.click())
  expect(ctx.remote.llm.discoverModels).toHaveBeenLastCalledWith("copilot-api-provider", { baseURL: "http://localhost:4141/v1" })
  controller.abort()
  await stream.next()
})

it("refreshes on provider invalidations, retains failures as resource frames, and disposes listeners", async () => {
  const { ctx, resource, emit, listeners } = await browser()
  const controller = new AbortController()
  const stream = resource.open("dsh-resource://copilot-api-models/custom%2Did", { signal: controller.signal })
  expect((await stream.next()).value.ok).toBe(true)
  expect(ctx.remote.llm.discoverModels).toHaveBeenCalledWith("custom-id", { provider: "copilot-api" })
  const waiting = stream.next()
  ctx.remote.llm.discoverModels.mockResolvedValueOnce({ ok: false, error: { code: "offline", message: "Gateway offline" } })
  emit("llm/adapters-updated")
  expect((await waiting).value).toMatchObject({ ok: false, error: { message: "Gateway offline" } })
  ctx.remote.session.modelCatalog.mockResolvedValueOnce({ ok: false, error: { code: "offline", message: "Catalog offline" } })
  emit("connection/reset")
  expect((await stream.next()).value.ok).toBe(false)
  ctx.remote.session.modelCatalog.mockResolvedValueOnce({ ok: true, value: { groups: [], failures: [{ id: "copilot-api", message: "Provider error" }] } })
  emit("credentials/reference-updated")
  expect((await stream.next()).value).toMatchObject({ ok: false, error: { message: "Provider error" } })
  ctx.remote.session.modelCatalog.mockResolvedValueOnce({ ok: true, value: { groups: [], failures: [] } })
  emit("connection/reset")
  expect((await stream.next()).value).toMatchObject({ ok: true, value: [{ efforts: [] }] })
  const closing = stream.next()
  controller.abort()
  expect((await closing).done).toBe(true)
  expect([...listeners.values()].every(set => set.size === 0)).toBe(true)
})

it.each([
  { status: "loading", value: undefined, text: "Loading models" },
  { status: "live", value: [], text: "No models advertised" },
  { status: "failed", value: [{ id: "text-only", name: "Text model", efforts: [] }], failure: { message: "Refresh failed" }, text: "Refresh failed" },
])("renders resource loading, empty and failure states", async state => {
  const { seat, Component } = await browser()
  const node = document.createElement("div")
  root = createRoot(node)
  await act(async () => root?.render(React.createElement(Component, {
    ...seat.inject(), provider: { settingsNs: "copilot-api-provider" }, useResource: () => state,
  })))
  expect(node.textContent).toContain(state.text)
  if (state.value?.length) expect(node.textContent).toContain("Not advertised")
})

it("shows a manual refresh failure in the card", async () => {
  const { ctx, seat, Component } = await browser()
  const node = document.createElement("div")
  root = createRoot(node)
  ctx.remote.llm.discoverModels.mockResolvedValueOnce({ ok: false, error: { message: "Refresh refused" } })
  await act(async () => root?.render(React.createElement(Component, {
    ...seat.inject(), provider: { settingsNs: "copilot-api-provider" }, useResource: () => ({ status: "live", value: [] }),
  })))
  await act(async () => node.querySelector("button")?.click())
  expect(node.textContent).toContain("Refresh refused")
})

it("saves keys only through Harness credentials and clears the password field", async () => {
  const { ctx, seat, Component } = await browser()
  const node = document.createElement("div")
  root = createRoot(node)
  await act(async () => root?.render(React.createElement(Component, {
    ...seat.inject(), provider: { settingsNs: "copilot-api-provider", nativeAuth: { env: ["GITHUB_COPILOT_API_KEY"] } },
    useResource: () => ({ status: "live", value: [] }),
  })))
  const input = node.querySelector("input")!
  // Use the native setter so React observes a user edit rather than its value tracker.
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "test-secret")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  expect(ctx.remote.credentials.set).toHaveBeenCalledWith("GITHUB_COPILOT_API_KEY", "test-secret")
  expect(input.value).toBe("")
  expect(node.textContent).toContain("API key saved securely")
  ctx.remote.credentials.set.mockResolvedValueOnce({ ok: false, error: { message: "Read-only credentials" } })
  expect(await seat.inject().storeKey("GITHUB_COPILOT_API_KEY", "test-secret")).toBe("Read-only credentials")
})
