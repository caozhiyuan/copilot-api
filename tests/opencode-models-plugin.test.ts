import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { OpencodeModel } from "~/routes/models/opencode-models"

import modelsPlugin from "../plugin/opencode/copilot-api-provider.js"

interface ProviderSource {
  info: {
    id: string
    name: string
    activation: string
    package: string
    settings: {
      baseURL: string
      apiKey: string
      compaction: { type: "native" }
    }
  }
  models: Array<OpencodeModel>
}

type Transform = (editor: { add: (source: ProviderSource) => void }) => void

const plugin = modelsPlugin as {
  id: string
  setup: (ctx: {
    options?: {
      baseURL?: string
      apiKey?: string
      refreshIntervalMs?: number
    }
    provider: {
      transform: (callback: Transform) => Promise<void>
      reload: () => Promise<void>
    }
  }) => Promise<(() => void) | undefined>
}

const model = (id: string): OpencodeModel => ({
  id,
  modelID: id,
  providerID: "local",
  name: id,
  package: "@opencode/ai/providers/openai/responses",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [],
  time: { released: 0 },
  cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 1.25 } }],
  status: "active",
  enabled: true,
  limit: { context: 200_000, output: 32_000 },
})

const imageModel = (id: string, name: string): OpencodeModel => ({
  id,
  modelID: id,
  providerID: "local",
  type: "image",
  name,
  family: "gpt-image",
  package: "@opencode/ai/providers/openai/images",
  capabilities: { tools: false, input: ["text", "image"], output: ["image"] },
  variants: [],
  time: { released: 0 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  status: "active",
  enabled: true,
  limit: { context: 0, output: 0 },
})

const originalFetch = globalThis.fetch
const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
const originalWarn = console.warn
const originalKey = process.env.GITHUB_COPILOT_API_KEY
const originalURL = process.env.COPILOT_API_URL
let tick: (() => void) | undefined
const timer = 1 as unknown as ReturnType<typeof setInterval>
const fetchMock = mock(() =>
  Promise.resolve(Response.json({ data: [model("first")] })),
)
const intervalMock = mock((callback: () => void, _delay: number) => {
  tick = callback
  return timer
})
const clearMock = mock((_timer: ReturnType<typeof setInterval>) => {})
const warnMock = mock((..._args: Array<unknown>) => {})

beforeEach(() => {
  tick = undefined
  delete process.env.GITHUB_COPILOT_API_KEY
  delete process.env.COPILOT_API_URL
  fetchMock.mockReset()
  fetchMock.mockImplementation(() =>
    Promise.resolve(Response.json({ data: [model("first")] })),
  )
  intervalMock.mockClear()
  clearMock.mockClear()
  warnMock.mockClear()
  globalThis.fetch = fetchMock as unknown as typeof fetch
  globalThis.setInterval = intervalMock as unknown as typeof setInterval
  globalThis.clearInterval = clearMock as unknown as typeof clearInterval
  console.warn = warnMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
  console.warn = originalWarn
  if (originalKey === undefined) delete process.env.GITHUB_COPILOT_API_KEY
  else process.env.GITHUB_COPILOT_API_KEY = originalKey
  if (originalURL === undefined) delete process.env.COPILOT_API_URL
  else process.env.COPILOT_API_URL = originalURL
})

async function createPlugin(
  options?: Parameters<typeof plugin.setup>[0]["options"],
) {
  let source: ProviderSource | undefined
  let transform: Transform | undefined
  const apply = (callback: Transform) =>
    callback({
      add: (value) => {
        source = value
      },
    })
  const reload = mock(() => {
    if (transform) apply(transform)
    return Promise.resolve()
  })
  const cleanup = await plugin.setup({
    options,
    provider: {
      transform: (callback) => {
        transform = callback
        apply(callback)
        return Promise.resolve()
      },
      reload,
    },
  })
  return {
    get source() {
      return source
    },
    reload,
    cleanup,
  }
}

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 1_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Plugin refresh timed out")
    await Bun.sleep(1)
  }
}

describe("OpenCode v2 model discovery plugin", () => {
  test("registers an enabled Responses provider with native compaction using a single JS file", async () => {
    const result = await createPlugin()
    expect(plugin.id).toBe("local.provider")
    expect(result.source?.info).toEqual({
      id: "local",
      name: "My Local",
      activation: "enabled",
      package: "@opencode/ai/providers/openai/responses",
      settings: {
        baseURL: "http://localhost:4141/v1",
        apiKey: "dummy",
        compaction: { type: "native" },
      },
    })
    expect(result.source?.models).toEqual([model("first")])
    const [url, init] = (
      fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    )[0]
    expect(url).toBe("http://localhost:4141/v1/models")
    const headers = new Headers(init.headers)
    expect(headers.get("user-agent")).toContain("opencode")
    expect(headers.get("x-api-key")).toBe("dummy")
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(intervalMock).toHaveBeenCalledWith(expect.any(Function), 120_000)
    result.cleanup?.()
    expect(clearMock).toHaveBeenCalledWith(timer)
  })

  test("preserves gateway-listed Codex and xAI image models and their packages", async () => {
    const listed = [
      model("chat"),
      imageModel("codex/gpt-image-2", "GPT Image 2"),
      {
        ...imageModel("xai/grok-imagine-image-2.0", "Grok Imagine Image 2.0"),
        family: "grok-imagine",
        cost: [],
      },
    ]
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ data: listed })),
    )
    const result = await createPlugin({ refreshIntervalMs: 0 })
    expect(result.source?.models).toEqual(listed)
  })

  test("uses Responses for older catalogs without a model package", async () => {
    const legacy: Partial<OpencodeModel> = model("legacy")
    delete legacy.package
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ data: [legacy] })),
    )
    const result = await createPlugin({ refreshIntervalMs: 0 })
    expect(result.source?.models).toEqual([model("legacy")])
  })

  test("keeps an empty server catalog empty without injecting image models", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ data: [] })),
    )
    const result = await createPlugin({ refreshIntervalMs: 0 })
    expect(result.source?.models).toEqual([])
  })

  test("uses the same environment key as Codex and trims the gateway URL", async () => {
    process.env.GITHUB_COPILOT_API_KEY = "gateway-test-key"
    process.env.COPILOT_API_URL = "http://127.0.0.1:4242/v1///"
    const result = await createPlugin({ refreshIntervalMs: 0 })
    expect(result.source?.info.settings).toEqual({
      baseURL: "http://127.0.0.1:4242/v1",
      apiKey: "gateway-test-key",
      compaction: { type: "native" },
    })
    const [url, init] = (
      fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    )[0]
    expect(url).toBe("http://127.0.0.1:4242/v1/models")
    expect(new Headers(init.headers).get("x-api-key")).toBe("gateway-test-key")
    expect(intervalMock).not.toHaveBeenCalled()
    expect(result.cleanup).toBeUndefined()
  })

  test("allows explicit options to override environment settings", async () => {
    process.env.GITHUB_COPILOT_API_KEY = "environment-key"
    process.env.COPILOT_API_URL = "http://environment.example/v1"
    const result = await createPlugin({
      baseURL: "http://options.example/v1/",
      apiKey: "options-key",
      refreshIntervalMs: 30_000,
    })
    expect(result.source?.info.settings).toEqual({
      baseURL: "http://options.example/v1",
      apiKey: "options-key",
      compaction: { type: "native" },
    })
    expect(intervalMock).toHaveBeenCalledWith(expect.any(Function), 30_000)
    result.cleanup?.()
  })

  test("refreshes image model additions and removals while preserving packages and native compaction", async () => {
    const result = await createPlugin()
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json({
          data: [
            {
              ...model("second"),
              providerID: "upstream",
            },
            imageModel("xai/grok-imagine-image-2.0", "Grok Imagine Image 2.0"),
          ],
        }),
      ),
    )
    tick?.()
    await waitFor(() => result.reload.mock.calls.length === 1)
    expect(result.source?.models).toEqual([
      model("second"),
      imageModel("xai/grok-imagine-image-2.0", "Grok Imagine Image 2.0"),
    ])
    expect(result.source?.info.settings.compaction).toEqual({ type: "native" })
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ data: [] })),
    )
    tick?.()
    await waitFor(() => result.reload.mock.calls.length === 2)
    expect(result.source?.models).toEqual([])
    expect(result.source?.info.settings.compaction).toEqual({ type: "native" })
    result.cleanup?.()
  })

  test.each([
    () => Promise.resolve(new Response("unavailable", { status: 503 })),
    () => Promise.resolve(Response.json({ data: [{ id: "v1-model" }] })),
    () => Promise.resolve(new Response("invalid json")),
    () => Promise.reject(new Error("offline")),
  ])("retains the previous catalog after a failed refresh", async (fail) => {
    const result = await createPlugin()
    fetchMock.mockImplementationOnce(fail)
    tick?.()
    await waitFor(() => warnMock.mock.calls.length === 1)
    expect(result.source?.models).toEqual([model("first")])
    expect(result.reload).not.toHaveBeenCalled()
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ data: [model("recovered")] })),
    )
    tick?.()
    await waitFor(() => result.reload.mock.calls.length === 1)
    expect(result.source?.models[0].id).toBe("recovered")
    result.cleanup?.()
  })

  test("recovers when the gateway is unavailable at startup", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response("unavailable", { status: 503 })),
    )
    const result = await createPlugin()
    expect(result.source?.models).toEqual([])
    expect(warnMock).toHaveBeenCalledTimes(1)
    tick?.()
    await waitFor(() => result.reload.mock.calls.length === 1)
    expect(result.source?.models[0].id).toBe("first")
    result.cleanup?.()
  })

  test("avoids overlapping refreshes and stops publishing after cleanup", async () => {
    const result = await createPlugin()
    let resolveResponse: ((response: Response) => void) | undefined
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve
        }),
    )
    tick?.()
    tick?.()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    result.cleanup?.()
    resolveResponse?.(Response.json({ data: [model("late")] }))
    await Bun.sleep(10)
    tick?.()
    expect(result.reload).not.toHaveBeenCalled()
    expect(result.source?.models[0].id).toBe("first")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
