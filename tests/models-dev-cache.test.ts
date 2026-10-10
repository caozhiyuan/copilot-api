import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { builtinProviderModelRegistry } from "~/lib/builtin-provider-models"
import { resolveTokenUsageCost } from "~/lib/token-usage/pricing"
import {
  getModelsDevModelApi,
  getModelsDevModel,
  getModelsDevModelConfig,
  getModelsDevModelMaxOutputTokens,
  getModelsDevModelPricing,
  getModelsDevModelProviderType,
  getModelsDevProviderOptions,
  getModelsDevProviderModelIds,
  loadCachedModelsDevCatalog,
  getOpencodeGoModelIds,
  getOpencodeGoModelProviderType,
  getOpencodeGoModelRecords,
  installModelsDevCatalog,
  loadModelsDevProviderOptions,
  startModelsDevCache,
  stopModelsDevRefreshLoop,
} from "~/lib/models-dev-cache"

import {
  modelsDevCatalogFixture,
  modelsDevReleaseModelsFixture,
} from "./fixtures/models-dev-catalog"

let tempDir: string | undefined

async function getCachePath(): Promise<string> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-api-models-dev-"))
  return path.join(tempDir, "models-dev-api.json")
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await condition()) return
    await Bun.sleep(5)
  }
  throw new Error(message)
}

afterEach(async () => {
  await stopModelsDevRefreshLoop()
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

test("filters older releases consistently across models.dev lists, protocols, limits and pricing", () => {
  const models = {
    ...modelsDevReleaseModelsFixture,
    "before-cutoff": {
      ...modelsDevReleaseModelsFixture["before-cutoff"],
      limit: { output: 32_000 },
      cost: { input: 1, output: 2 },
      provider: { api: "https://old.example/v1" },
    },
  }
  const catalog = {
    ...modelsDevCatalogFixture,
    "opencode-go": { npm: "@ai-sdk/openai-compatible", models },
    example: {
      npm: "@ai-sdk/openai-compatible",
      api: "https://example.com/v1",
      models,
    },
  }
  const original = structuredClone(catalog)
  installModelsDevCatalog(catalog)
  const visibleIds = [
    "after-cutoff",
    "invalid-date",
    "on-cutoff",
    "unknown-date",
  ]
  expect(getOpencodeGoModelIds()).toEqual(visibleIds)
  expect(getModelsDevProviderModelIds("example")).toEqual(visibleIds)
  expect(getModelsDevModelConfig("example", "before-cutoff")).toBeUndefined()
  expect(getModelsDevModelPricing("example", "before-cutoff")).toBeUndefined()
  expect(
    getModelsDevModelMaxOutputTokens("example", "before-cutoff"),
  ).toBeUndefined()
  expect(
    getModelsDevModelProviderType("example", "before-cutoff"),
  ).toBeUndefined()
  expect(getModelsDevModelApi("example", "before-cutoff")).toBeUndefined()
  expect(getModelsDevModelProviderType("example", "on-cutoff")).toBe(
    "openai-compatible",
  )
  expect(catalog).toEqual(original)
})

test("exposes raw models.dev metadata even for providers excluded from the provider picker", () => {
  installModelsDevCatalog({
    ...modelsDevCatalogFixture,
    "github-copilot": {
      models: {
        invalid: null,
        vision: {
          id: "vision",
          cost: { input: 1, output: 2 },
          modalities: { input: ["text", "image"], output: ["text"] },
        },
      },
    },
  })
  expect(getModelsDevModel("opencode-go", "hy3")?.cost).toEqual(
    modelsDevCatalogFixture["opencode-go"].models.hy3.cost,
  )
  expect(getModelsDevModel("github-copilot", "vision")?.cost).toEqual({
    input: 1,
    output: 2,
  })
  expect(getModelsDevModel("github-copilot", "invalid")).toBeUndefined()
  expect(getModelsDevModel("missing", "vision")).toBeUndefined()
  expect(getModelsDevModel("opencode-go", "missing")).toBeUndefined()
})

test("lists usable Chat, Responses, and Anthropic providers without the built-in choices", async () => {
  installModelsDevCatalog({
    ...modelsDevCatalogFixture,
    "opencode-go": {
      ...modelsDevCatalogFixture["opencode-go"],
      api: "https://opencode.example/v1",
    },
    "chat-provider": {
      name: "Chat Provider",
      npm: "@ai-sdk/openai-compatible",
      api: "https://chat.example/api/v4/",
      models: {
        chat: {
          id: "chat",
          cost: { input: 0.1, output: 0.5, cache_read: 0.01 },
        },
        response: {
          id: "response",
          provider: {
            npm: "@ai-sdk/openai",
            api: "https://responses.example/v1",
          },
        },
        claude: {
          id: "claude",
          provider: { npm: "@ai-sdk/anthropic" },
        },
      },
    },
    "responses-provider": {
      npm: "@ai-sdk/openai",
      api: "https://responses.example/v1",
      models: {
        completion: {
          id: "completion",
          provider: { shape: "completions" },
        },
      },
    },
    "anthropic-provider": {
      npm: "@ai-sdk/anthropic",
      api: "https://anthropic.example/v1",
      models: {},
    },
    openrouter: {
      npm: "@ai-sdk/openai-compatible",
      api: "https://openrouter.example/v1",
    },
    "github-copilot": {
      npm: "@ai-sdk/openai-compatible",
      api: "https://copilot.example/v1",
    },
    "missing-api": { npm: "@ai-sdk/openai-compatible" },
    templated: {
      npm: "@ai-sdk/openai-compatible",
      api: "https://${ACCOUNT}.example/v1",
    },
    unsupported: {
      npm: "@ai-sdk/google",
      api: "https://google.example/v1",
    },
  })

  expect(await loadModelsDevProviderOptions()).toEqual(
    getModelsDevProviderOptions(),
  )
  await loadCachedModelsDevCatalog()
  expect(getModelsDevProviderModelIds("responses-provider")).toEqual([
    "completion",
  ])
  expect(getModelsDevProviderModelIds("unknown-provider")).toEqual([])
  expect(getModelsDevProviderOptions()).toEqual([
    {
      id: "anthropic-provider",
      name: "anthropic-provider",
      api: "https://anthropic.example/v1",
      type: "anthropic",
    },
    {
      id: "chat-provider",
      name: "Chat Provider",
      api: "https://chat.example/api/v4",
      type: "openai-compatible",
    },
    {
      id: "responses-provider",
      name: "responses-provider",
      api: "https://responses.example/v1",
      type: "openai-responses",
    },
  ])
  expect(getModelsDevModelProviderType("chat-provider", "response")).toBe(
    "openai-responses",
  )
  expect(getModelsDevModelProviderType("chat-provider", "claude")).toBe(
    "anthropic",
  )
  expect(
    getModelsDevModelProviderType("responses-provider", "completion"),
  ).toBe("openai-compatible")
  expect(getModelsDevModelApi("chat-provider", "response")).toBe(
    "https://responses.example/v1",
  )
  expect(getModelsDevModelPricing("chat-provider", "chat")).toEqual({
    input: 0.1,
    output: 0.5,
    cachedInput: 0.01,
  })
})

test("resolves output limits for all cached providers and ignores unknown or deprecated models", () => {
  installModelsDevCatalog({
    ...modelsDevCatalogFixture,
    openrouter: {
      models: {
        "org/model": { limit: { output: 131_072 } },
        deprecated: { status: "deprecated", limit: { output: 65_536 } },
        malformed: null,
      },
    },
    "custom-provider": { models: { model: { limit: { output: 8_192 } } } },
    "invalid-provider": null,
    "missing-models": {},
  })

  expect(getModelsDevModelMaxOutputTokens("openrouter", "org/model")).toBe(
    131_072,
  )
  expect(getModelsDevModelMaxOutputTokens("custom-provider", "model")).toBe(
    8_192,
  )
  expect(getModelsDevModelMaxOutputTokens("opencode-go", "gpt-6-luna")).toBe(
    128_000,
  )
  expect(
    getModelsDevModelMaxOutputTokens("openrouter", "deprecated"),
  ).toBeUndefined()
  expect(
    getModelsDevModelMaxOutputTokens("openrouter", "malformed"),
  ).toBeUndefined()
  expect(
    getModelsDevModelMaxOutputTokens("openrouter", "unknown"),
  ).toBeUndefined()
  expect(
    getModelsDevModelMaxOutputTokens("unknown", "org/model"),
  ).toBeUndefined()
})

test.each([undefined, null, 0, -1, 1.5, NaN, Infinity, "65536"])(
  "ignores invalid cached output limits %j",
  (output) => {
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      "custom-provider": { models: { model: { limit: { output } } } },
    })

    expect(
      getModelsDevModelMaxOutputTokens("custom-provider", "model"),
    ).toBeUndefined()
  },
)

test("persists the full models.dev response and filters deprecated models in memory", async () => {
  const cachePath = await getCachePath()
  const document = {
    ...modelsDevCatalogFixture,
    "another-provider": { id: "another-provider", models: { example: {} } },
  }
  let requestedUrl: string | undefined
  await startModelsDevCache({
    cachePath,
    fetcher: (url: string | URL | Request) => {
      requestedUrl =
        typeof url === "string" ? url
        : url instanceof URL ? url.href
        : url.url
      return Promise.resolve(
        Response.json(document, {
          headers: {
            ETag: '"catalog-v1"',
            "Last-Modified": "Fri, 25 Sep 2026 00:00:00 GMT",
          },
        }),
      )
    },
  })

  await waitFor(
    async () =>
      (await fs
        .stat(cachePath.replace(/\.json$/, ".meta.json"))
        .catch(() => null)) !== null,
    "models.dev metadata was not saved",
  )

  expect(requestedUrl).toBe("https://models.dev/api.json")
  const savedBody = await fs.readFile(cachePath, "utf8")
  expect(JSON.parse(savedBody)).toEqual(document)
  expect(
    JSON.parse(
      await fs.readFile(cachePath.replace(/\.json$/, ".meta.json"), "utf8"),
    ),
  ).toEqual({
    sha256: createHash("sha256").update(savedBody).digest("hex"),
    etag: '"catalog-v1"',
    lastModified: "Fri, 25 Sep 2026 00:00:00 GMT",
  })
  expect(getOpencodeGoModelIds()).toContain("gpt-6-luna")
  expect(getOpencodeGoModelIds()).toContain("qwen3.8-flash")
  expect(getOpencodeGoModelIds()).not.toContain("grok-4.5")
  expect(getOpencodeGoModelRecords().map((model) => model.id)).not.toContain(
    "ox-alpha-free",
  )
  expect(
    builtinProviderModelRegistry.getModelConfig("opencode-go", "gpt-6-luna"),
  ).toMatchObject({
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    inputModalities: ["text", "image"],
    pricing: {
      tiers: [
        {
          input: 0.1,
          output: 0.5,
          cachedInput: 0.01,
          cacheCreationInput: 0.125,
          maxInputTokens: 271_999,
        },
        {
          input: 0.2,
          output: 0.75,
          cachedInput: 0.02,
          cacheCreationInput: 0.25,
        },
      ],
    },
  })
})

test("serves disk models before the background network refresh finishes", async () => {
  const cachePath = await getCachePath()
  const document = {
    ...modelsDevCatalogFixture,
    "custom-provider": { models: { model: { limit: { output: 131_072 } } } },
  }
  await fs.writeFile(cachePath, JSON.stringify(document))
  let finishFetch: ((response: Response) => void) | undefined
  const response = new Promise<Response>((resolve) => {
    finishFetch = resolve
  })

  await startModelsDevCache({
    cachePath,
    fetcher: () => response,
  })

  expect(getOpencodeGoModelIds()).toContain("gpt-6-luna")
  expect(getModelsDevModelMaxOutputTokens("custom-provider", "model")).toBe(
    131_072,
  )
  expect(finishFetch).toBeDefined()
  finishFetch?.(Response.json(modelsDevCatalogFixture))
  await waitFor(
    async () =>
      (await fs
        .stat(cachePath.replace(/\.json$/, ".meta.json"))
        .catch(() => null)) !== null,
    "background refresh did not finish",
  )
})

test("waits for the first network catalog when no disk cache exists", async () => {
  const cachePath = await getCachePath()
  let finishFetch: ((response: Response) => void) | undefined
  let fetchStarted = false
  const response = new Promise<Response>((resolve) => {
    finishFetch = resolve
  })
  const startup = startModelsDevCache({
    cachePath,
    fetcher: () => {
      fetchStarted = true
      return response
    },
  })
  await waitFor(() => fetchStarted, "initial catalog fetch did not start")

  let startupFinished = false
  void startup.then(() => {
    startupFinished = true
  })
  expect(startupFinished).toBe(false)
  expect(getOpencodeGoModelIds()).toEqual([])

  finishFetch?.(Response.json(modelsDevCatalogFixture))
  await startup
  expect(startupFinished).toBe(true)
  expect(getOpencodeGoModelIds()).toContain("qwen3.8-flash")
})

test("fails startup when the first catalog cannot be fetched", async () => {
  const cachePath = await getCachePath()
  let startupError: unknown
  try {
    await startModelsDevCache({
      cachePath,
      fetcher: () => Promise.reject(new Error("offline")),
    })
  } catch (error) {
    startupError = error
  }
  expect(startupError).toBeInstanceOf(Error)
  expect((startupError as Error).message).toContain(
    "Failed to fetch initial models.dev catalog: offline",
  )
  expect(getOpencodeGoModelIds()).toEqual([])
})

test("uses the higher price at the models.dev context tier threshold", () => {
  installModelsDevCatalog(modelsDevCatalogFixture)
  const costAt = (inputTokens: number) =>
    resolveTokenUsageCost({
      source: "provider",
      providerName: "opencode-go",
      model: "gpt-6-luna",
      input_tokens: inputTokens,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })?.total_cost_nanos

  expect(costAt(271_999)).toBe(27_199_900)
  expect(costAt(272_000)).toBe(54_400_000)
})

test("loads the full disk cache before a failed startup fetch", async () => {
  const cachePath = await getCachePath()
  await fs.writeFile(cachePath, JSON.stringify(modelsDevCatalogFixture))
  installModelsDevCatalog({
    "opencode-go": {
      models: { temporary: { id: "temporary", name: "Temporary" } },
    },
  })

  await startModelsDevCache({
    cachePath,
    fetcher: () => Promise.reject(new Error("offline")),
  })

  expect(getOpencodeGoModelIds()).toContain("gpt-6-luna")
  expect(getOpencodeGoModelIds()).not.toContain("temporary")
  expect(getOpencodeGoModelProviderType("gpt-6-luna")).toBe("openai-responses")
  expect(JSON.parse(await fs.readFile(cachePath, "utf8"))).toEqual(
    modelsDevCatalogFixture,
  )
})

test("refreshes the catalog and disk cache on the configured interval", async () => {
  const cachePath = await getCachePath()
  const updatedDocument = {
    ...modelsDevCatalogFixture,
    "opencode-go": {
      ...modelsDevCatalogFixture["opencode-go"],
      models: {
        ...modelsDevCatalogFixture["opencode-go"].models,
        "new-model": {
          id: "new-model",
          name: "New Model",
          provider: { npm: "@ai-sdk/anthropic" },
          cost: { input: 1, output: 2 },
        },
      },
    },
  }
  let calls = 0
  await startModelsDevCache({
    cachePath,
    intervalMs: 20,
    fetcher: () => {
      calls += 1
      return Promise.resolve(
        Response.json(calls === 1 ? modelsDevCatalogFixture : updatedDocument),
      )
    },
  })

  const deadline = Date.now() + 1_000
  let saved = false
  while (!saved && Date.now() < deadline) {
    const savedBody = await fs.readFile(cachePath, "utf8").catch(() => null)
    const savedDocument =
      savedBody ?
        (JSON.parse(savedBody) as {
          "opencode-go": { models: Record<string, unknown> }
        })
      : null
    saved =
      getOpencodeGoModelIds().includes("new-model")
      && savedDocument !== null
      && Object.hasOwn(savedDocument["opencode-go"].models, "new-model")
    await Bun.sleep(5)
  }
  await stopModelsDevRefreshLoop()

  expect(calls).toBeGreaterThanOrEqual(2)
  expect(saved).toBe(true)
  expect(getOpencodeGoModelIds()).toContain("new-model")
  expect(getOpencodeGoModelProviderType("new-model")).toBe("anthropic")
  expect(JSON.parse(await fs.readFile(cachePath, "utf8"))).toEqual(
    updatedDocument,
  )
})

test("uses ETag for conditional refresh and keeps the full cache on HTTP 304", async () => {
  const cachePath = await getCachePath()
  const requestHeaders: Array<Headers> = []
  await startModelsDevCache({
    cachePath,
    intervalMs: 20,
    fetcher: (_url: string | URL | Request, init?: RequestInit) => {
      requestHeaders.push(new Headers(init?.headers))
      return Promise.resolve(
        requestHeaders.length === 1 ?
          Response.json(modelsDevCatalogFixture, {
            headers: { ETag: '"catalog-v1"' },
          })
        : new Response(null, {
            status: 304,
            headers: { ETag: '"catalog-v2"' },
          }),
      )
    },
  })

  await waitFor(async () => {
    const metadata = await fs
      .readFile(cachePath.replace(/\.json$/, ".meta.json"), "utf8")
      .catch(() => null)
    return (
      requestHeaders.length >= 2
      && metadata !== null
      && (JSON.parse(metadata) as { etag?: string }).etag === '"catalog-v2"'
    )
  }, "304 metadata refresh did not finish")
  await stopModelsDevRefreshLoop()

  expect(requestHeaders.length).toBeGreaterThanOrEqual(2)
  expect(requestHeaders[0].get("if-none-match")).toBeNull()
  expect(requestHeaders[1].get("if-none-match")).toBe('"catalog-v1"')
  expect(getOpencodeGoModelIds()).toContain("gpt-6-luna")
  expect(JSON.parse(await fs.readFile(cachePath, "utf8"))).toEqual(
    modelsDevCatalogFixture,
  )
})

test("uses Last-Modified when models.dev does not send an ETag", async () => {
  const cachePath = await getCachePath()
  const requestHeaders: Array<Headers> = []
  await startModelsDevCache({
    cachePath,
    intervalMs: 20,
    fetcher: (_url: string | URL | Request, init?: RequestInit) => {
      requestHeaders.push(new Headers(init?.headers))
      return Promise.resolve(
        requestHeaders.length === 1 ?
          Response.json(modelsDevCatalogFixture, {
            headers: { "Last-Modified": "Fri, 25 Sep 2026 00:00:00 GMT" },
          })
        : new Response(null, {
            status: 304,
            headers: { "Last-Modified": "Sat, 26 Sep 2026 00:00:00 GMT" },
          }),
      )
    },
  })

  await waitFor(async () => {
    const metadata = await fs
      .readFile(cachePath.replace(/\.json$/, ".meta.json"), "utf8")
      .catch(() => null)
    return (
      requestHeaders.length >= 2
      && metadata !== null
      && (JSON.parse(metadata) as { lastModified?: string }).lastModified
        === "Sat, 26 Sep 2026 00:00:00 GMT"
    )
  }, "304 Last-Modified refresh did not finish")
  await stopModelsDevRefreshLoop()

  expect(requestHeaders.length).toBeGreaterThanOrEqual(2)
  expect(requestHeaders[1].get("if-modified-since")).toBe(
    "Fri, 25 Sep 2026 00:00:00 GMT",
  )
  expect(requestHeaders[1].get("if-none-match")).toBeNull()
})

test("reuses disk validators after restart when their checksum matches", async () => {
  const cachePath = await getCachePath()
  await startModelsDevCache({
    cachePath,
    fetcher: () =>
      Promise.resolve(
        Response.json(modelsDevCatalogFixture, {
          headers: { ETag: '"catalog-v1"' },
        }),
      ),
  })
  await waitFor(
    async () =>
      (await fs
        .stat(cachePath.replace(/\.json$/, ".meta.json"))
        .catch(() => null)) !== null,
    "initial cache metadata was not saved",
  )
  await stopModelsDevRefreshLoop()
  installModelsDevCatalog({
    "opencode-go": {
      models: { temporary: { id: "temporary", name: "Temporary" } },
    },
  })

  let restartHeaders: Headers | undefined
  await startModelsDevCache({
    cachePath,
    fetcher: (_url, init) => {
      restartHeaders = new Headers(init?.headers)
      return Promise.resolve(new Response(null, { status: 304 }))
    },
  })

  expect(restartHeaders?.get("if-none-match")).toBe('"catalog-v1"')
  expect(getOpencodeGoModelIds()).toContain("gpt-6-luna")
  expect(getOpencodeGoModelIds()).not.toContain("temporary")
})

test("ignores disk validators when they do not match the JSON", async () => {
  const cachePath = await getCachePath()
  await fs.writeFile(cachePath, JSON.stringify(modelsDevCatalogFixture))
  await fs.writeFile(
    cachePath.replace(/\.json$/, ".meta.json"),
    JSON.stringify({ sha256: "wrong", etag: '"stale"' }),
  )

  let requestHeaders: Headers | undefined
  await startModelsDevCache({
    cachePath,
    fetcher: (_url, init) => {
      requestHeaders = new Headers(init?.headers)
      return Promise.resolve(Response.json(modelsDevCatalogFixture))
    },
  })

  expect(requestHeaders?.get("if-none-match")).toBeNull()
  expect(getOpencodeGoModelIds()).toContain("gpt-6-luna")
})

test("rejects malformed updates without replacing the last valid catalog", () => {
  installModelsDevCatalog(modelsDevCatalogFixture)
  expect(() =>
    installModelsDevCatalog({ "opencode-go": { models: {} } }),
  ).toThrow()
  expect(getOpencodeGoModelIds()).toContain("gpt-6-luna")
})

test("does not accept HTTP 304 when no disk or memory catalog exists", async () => {
  const cachePath = await getCachePath()
  let startupError: unknown
  try {
    await startModelsDevCache({
      cachePath,
      fetcher: () => Promise.resolve(new Response(null, { status: 304 })),
    })
  } catch (error) {
    startupError = error
  }
  expect(startupError).toBeInstanceOf(Error)
  expect((startupError as Error).message).toContain(
    "models.dev returned HTTP 304 without a cached catalog",
  )

  expect(getOpencodeGoModelIds()).toEqual([])
  expect(await fs.stat(cachePath).catch(() => null)).toBeNull()
})
