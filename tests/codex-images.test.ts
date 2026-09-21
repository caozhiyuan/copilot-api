import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import { MAX_IMAGE_GENERATION_BODY_SIZE_BYTES } from "~/routes/images/parsed-request"
import { MultipartBodyTooLargeError } from "~/routes/images/temp-form-data"

const actualConfigModule = await import("~/lib/config")
const actualTokenModule = await import("~/lib/token")

let codexProviderConfig: ResolvedProviderConfig | null = null
let openrouterProviderConfig: ResolvedProviderConfig | null = null
let modelMappings: Record<string, string> = {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: (provider: string) => {
    if (provider === "codex") return codexProviderConfig
    if (provider === "openrouter") return openrouterProviderConfig
    return null
  },
  getRawProviderConfig: (provider: string) => {
    if (provider === "codex") return codexProviderConfig
    if (provider === "openrouter") return openrouterProviderConfig
    return null
  },
  resolveMappedModel: (model: string) => modelMappings[model] ?? model,
}))

await mock.module("~/lib/token", () => ({
  ...actualTokenModule,
  setupCodexToken: async () => {},
}))

const { state } = await import("~/lib/state")
const { forwardCodexImages, resolveCodexImagesUrl } = await import(
  "~/services/codex/images"
)
const { imageEditsRouteDependencies, imageRouteDependencies, imageRoutes } =
  await import("~/routes/images/route")
const { providerImageRoutes } = await import("~/routes/provider/images/route")
const { server } = await import("~/server")

const originalDebugJsonAsync = imageRouteDependencies.debugJsonAsync
const originalResolveMappedModel = imageRouteDependencies.resolveMappedModel
const originalResolveProviderConfig =
  imageRouteDependencies.resolveProviderConfig
const originalStageMultipartBodyToDisk =
  imageEditsRouteDependencies.stageMultipartBodyToDisk
let stagedCleanupTasks: Array<() => Promise<void>> = []
let debugValues: Array<unknown> = []
const debugJsonAsyncMock = mock(
  async (
    _logger: Parameters<typeof originalDebugJsonAsync>[0],
    _label: string,
    factory: Parameters<typeof originalDebugJsonAsync>[2],
  ) => {
    if (state.verbose) {
      debugValues.push(await factory())
    }
  },
)

const originalFetch = globalThis.fetch
type StreamingRequestInit = RequestInit & { duplex?: "half" }
const fetchMock = mock(
  (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          created: 1_784_000_000,
          data: [{ b64_json: "generated-image" }],
        }),
        {
          headers: {
            "content-type": "application/json",
            "x-upstream": "codex",
          },
          status: 200,
        },
      ),
    ),
)

function createApp() {
  const app = new Hono()
  app.route("/images", imageRoutes)
  app.route("/v1/images", imageRoutes)
  app.route("/:provider/v1/images", providerImageRoutes)
  return app
}

beforeEach(() => {
  codexProviderConfig = {
    apiKey: "unused-provider-key",
    authType: "oauth2",
    baseUrl: "https://chatgpt.com/backend-api",
    name: "codex",
    type: "openai-responses",
  }
  openrouterProviderConfig = {
    apiKey: "openrouter-key",
    authType: "authorization",
    baseUrl: "https://openrouter.example",
    name: "openrouter",
    type: "openai-compatible",
  }
  modelMappings = {}
  state.codexAccessToken = "codex-access-token"
  state.codexAccountId = "account-123"
  state.verbose = false
  fetchMock.mockClear()
  debugJsonAsyncMock.mockClear()
  debugValues = []
  imageRouteDependencies.debugJsonAsync = debugJsonAsyncMock
  imageRouteDependencies.resolveMappedModel = (model) =>
    modelMappings[model] ?? model
  imageRouteDependencies.resolveProviderConfig = (provider) =>
    Promise.resolve(
      provider === "codex" ? codexProviderConfig
      : provider === "openrouter" ? openrouterProviderConfig
      : null,
    )
  stagedCleanupTasks = []
  imageEditsRouteDependencies.stageMultipartBodyToDisk = async (
    body,
    contentType,
  ) => {
    const staged = await originalStageMultipartBodyToDisk(body, contentType)
    stagedCleanupTasks.push(staged.cleanup)
    return staged
  }
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(async () => {
  await Promise.all(stagedCleanupTasks.map((cleanup) => cleanup()))
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.codexAccessToken = undefined
  state.codexAccountId = undefined
  state.verbose = false
  openrouterProviderConfig = null
  imageRouteDependencies.debugJsonAsync = originalDebugJsonAsync
  imageRouteDependencies.resolveMappedModel = originalResolveMappedModel
  imageRouteDependencies.resolveProviderConfig = originalResolveProviderConfig
  imageEditsRouteDependencies.stageMultipartBodyToDisk =
    originalStageMultipartBodyToDisk
})

describe("Codex images URL", () => {
  test("builds the generations URL and preserves query parameters", () => {
    expect(
      resolveCodexImagesUrl(
        "http://localhost/v1/images/generations?client=codex&format=png",
        "generations",
      ),
    ).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations?client=codex&format=png",
    )
  })

  test("builds the edits URL", () => {
    expect(resolveCodexImagesUrl("/images/edits", "edits")).toBe(
      "https://chatgpt.com/backend-api/codex/images/edits",
    )
  })
})

describe("Codex images forwarding", () => {
  test("forwards a JSON generation request and Codex auth headers", async () => {
    const payload = {
      model: "gpt-image-2",
      prompt: "A small robot watering a plant",
      quality: "high",
      size: "1024x1024",
    }

    const response = await createApp().request(
      "/images/generations?output=base64",
      {
        method: "POST",
        headers: {
          accept: "*/*",
          authorization: "Bearer client-token",
          "content-type": "application/json",
          cookie: "session=test-cookie",
          originator: "codex-tui",
          "user-agent": "codex-tui/test",
          "x-client-header": "kept",
        },
        body: JSON.stringify(payload),
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("x-upstream")).toBe("codex")
    expect(await response.json()).toEqual({
      created: 1_784_000_000,
      data: [{ b64_json: "generated-image" }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations?output=base64",
    )
    expect(init?.method).toBe("POST")
    expect((init as StreamingRequestInit | undefined)?.duplex).toBe("half")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
    expect(headers.get("accept")).toBe("*/*")
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("cookie")).toBe("session=test-cookie")
    expect(headers.get("originator")).toBe("codex-tui")
    expect(headers.get("user-agent")).toBe("codex-tui/test")
    expect(headers.get("x-client-header")).toBe("kept")
    expect(await new Response(init?.body).json()).toEqual(payload)
  })

  test("rebuilds unchanged generation bodies with one validated model", async () => {
    const response = await createApp().request("/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"claude-image-1","model":"gpt-image-2","prompt":"safe"}',
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(await new Response(init?.body).json()).toEqual({
      model: "gpt-image-2",
      prompt: "safe",
    })
  })

  test("rewrites a mapped JSON generation model before forwarding to Codex", async () => {
    modelMappings = {
      "gpt-image-1": "gpt-image-2",
    }

    const response = await createApp().request("/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: "mapped Codex image",
      }),
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations")
    expect(await new Response(init?.body).json()).toEqual({
      model: "gpt-image-2",
      prompt: "mapped Codex image",
    })
  })

  test("routes a mapped JSON generation model to its configured provider", async () => {
    codexProviderConfig = null
    modelMappings = {
      "gpt-image-1": "openrouter/openai/gpt-image-1",
    }

    const response = await createApp().request(
      "/v1/images/generations?output=base64",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt: "mapped provider image",
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://openrouter.example/v1/images/generations?output=base64",
    )
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer openrouter-key")
    expect(headers.has("chatgpt-account-id")).toBe(false)
    expect(await new Response(init?.body).json()).toEqual({
      model: "openai/gpt-image-1",
      prompt: "mapped provider image",
    })
  })

  test("forwards the original model to Codex when the mapped provider is unavailable", async () => {
    openrouterProviderConfig = null
    modelMappings = {
      "gpt-image-1": "openrouter/openai/gpt-image-1",
    }

    const response = await createApp().request("/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: "fallback to original model",
      }),
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(await new Response(init?.body).json()).toEqual({
      model: "gpt-image-1",
      prompt: "fallback to original model",
    })
  })

  test("preserves multipart fields and file bytes for image edits", async () => {
    state.verbose = true
    const formData = new FormData()
    formData.set("model", "gpt-image-2")
    formData.set("prompt", "Make the background transparent")
    formData.set(
      "image",
      new Blob(["source-image-bytes"], { type: "image/png" }),
      "source.png",
    )

    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      body: formData,
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits")

    const headers = new Headers(init?.headers)
    expect(headers.get("content-type")).toStartWith(
      "multipart/form-data; boundary=",
    )
    const forwardedResponse = new Response(init?.body, {
      headers,
    })
    const forwardedFormData = await forwardedResponse.formData()
    expect(forwardedFormData.get("model")).toBe("gpt-image-2")
    expect(forwardedFormData.get("prompt")).toBe(
      "Make the background transparent",
    )

    const image = forwardedFormData.get("image")
    expect(image).not.toBeNull()
    expect(typeof image).not.toBe("string")
    if (image === null || typeof image === "string") {
      throw new Error("Expected the forwarded image to be a file")
    }
    expect(image.name).toBe("source.png")
    expect(image.type).toBe("image/png")
    expect(await image.text()).toBe("source-image-bytes")
    expect(debugJsonAsyncMock).not.toHaveBeenCalled()
  })

  test("routes a mapped multipart edit model to its configured provider", async () => {
    modelMappings = {
      "edit-model": "openrouter/openai/gpt-image-1",
    }
    const formData = new FormData()
    formData.set("model", "edit-model")
    formData.set("prompt", "mapped provider edit")
    formData.set(
      "image",
      new Blob(["mapped-source-image"], { type: "image/png" }),
      "mapped-source.png",
    )

    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      body: formData,
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://openrouter.example/v1/images/edits")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer openrouter-key")
    expect(headers.get("content-type")).toStartWith(
      "multipart/form-data; boundary=",
    )

    const forwardedFormData = await new Response(init?.body, {
      headers,
    }).formData()
    expect(forwardedFormData.get("model")).toBe("openai/gpt-image-1")
    expect(forwardedFormData.get("prompt")).toBe("mapped provider edit")
    const image = forwardedFormData.get("image")
    expect(image).not.toBeNull()
    expect(typeof image).not.toBe("string")
    if (image === null || typeof image === "string") {
      throw new Error("Expected the forwarded image to be a file")
    }
    expect(image.name).toBe("mapped-source.png")
    expect(image.type).toBe("image/png")
    expect(await image.text()).toBe("mapped-source-image")
  })

  test("forwards a multipart edit without a model field to Codex", async () => {
    const formData = new FormData()
    formData.set("prompt", "no model field")
    formData.set(
      "image",
      new Blob(["raw-image-bytes"], { type: "image/png" }),
      "raw.png",
    )

    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      body: formData,
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits")

    const headers = new Headers(init?.headers)
    const forwardedFormData = await new Response(init?.body, {
      headers,
    }).formData()
    expect(forwardedFormData.get("prompt")).toBe("no model field")
    const image = forwardedFormData.get("image")
    if (image === null || typeof image === "string") {
      throw new Error("Expected the forwarded image to be a file")
    }
    expect(image.name).toBe("raw.png")
    expect(await image.text()).toBe("raw-image-bytes")
  })

  test("rejects a malformed multipart edit body without forwarding", async () => {
    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=broken" },
      body: "this is not multipart",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "Invalid multipart form data body",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("streams a non-multipart edit body to Codex unchanged", async () => {
    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "raw-bytes",
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits")
    expect(await new Response(init?.body).text()).toBe("raw-bytes")
  })

  test("forwards a non-JSON generation body as-is to Codex", async () => {
    const response = await createApp().request("/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations")
    expect(await new Response(init?.body).text()).toBe("not-json")
  })

  test("preserves non-UTF8 generation bytes when forwarding unchanged", async () => {
    const body = new Uint8Array([0xff, 0x00, 0x7b, 0x7d])

    const response = await createApp().request("/v1/images/generations", {
      method: "POST",
      body,
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)
    expect(headers.get("content-type")).toBe("application/json")
    expect(
      new Uint8Array(await new Response(init?.body).arrayBuffer()),
    ).toEqual(body)
  })

  test("does not rewrite JSON-shaped generation bodies with invalid UTF-8", async () => {
    modelMappings = {
      "gpt-image-1": "gpt-image-2",
    }
    const encoder = new TextEncoder()
    const body = new Uint8Array([
      ...encoder.encode('{"model":"gpt-image-1","prompt":"'),
      0xff,
      ...encoder.encode('"}'),
    ])

    const response = await createApp().request("/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(
      new Uint8Array(await new Response(init?.body).arrayBuffer()),
    ).toEqual(body)
  })

  test("keeps the JSON default when rebuilding a headerless generation", async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ model: "gpt-image-2", prompt: "headerless JSON" }),
    )

    const response = await createApp().request("/v1/images/generations", {
      method: "POST",
      body,
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)
    expect(headers.get("content-type")).toBe("application/json")
    expect(await new Response(init?.body).json()).toEqual({
      model: "gpt-image-2",
      prompt: "headerless JSON",
    })
  })

  test("rejects oversized provider generation bodies before forwarding", async () => {
    const request = new Request(
      "http://localhost/openrouter/v1/images/generations",
      {
        method: "POST",
        headers: {
          "content-length": String(MAX_IMAGE_GENERATION_BODY_SIZE_BYTES + 1),
          "content-type": "application/json",
        },
        body: "{}",
      },
    )

    const response = await createApp().request(request)

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: {
        message: `Body exceeds the configured size limit of ${MAX_IMAGE_GENERATION_BODY_SIZE_BYTES} bytes`,
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("returns 413 when multipart staging exceeds its limits", async () => {
    imageEditsRouteDependencies.stageMultipartBodyToDisk = () =>
      Promise.reject(new MultipartBodyTooLargeError())
    const formData = new FormData()
    formData.set("image", new Blob(["image-bytes"]), "image.png")

    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      body: formData,
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: {
        message:
          "Multipart form data body exceeds the configured upload limits",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("reports temporary storage failures as server errors", async () => {
    imageEditsRouteDependencies.stageMultipartBodyToDisk = () =>
      Promise.reject(new Error("temporary storage unavailable"))
    const formData = new FormData()
    formData.set("image", new Blob(["image-bytes"]), "image.png")

    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      body: formData,
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: {
        message: "temporary storage unavailable",
        type: "error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("adds JSON defaults when request headers are absent", async () => {
    await forwardCodexImages(
      new Request("http://localhost/images/generations", {
        method: "POST",
        body: new Uint8Array([123, 125]),
      }),
      "generations",
    )

    const [, init] = fetchMock.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("content-type")).toBe("application/json")
  })

  test("does not label an edit request as JSON when content type is absent", async () => {
    await forwardCodexImages(
      new Request("http://localhost/images/edits", {
        method: "POST",
        body: new Uint8Array([1, 2, 3]),
      }),
      "edits",
    )

    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(new Headers(init?.headers).has("content-type")).toBe(false)
  })

  test("logs only the generation request body when debug logging is enabled", async () => {
    state.verbose = true
    const payload = { prompt: "debug body" }

    const response = await createApp().request("/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      created: 1_784_000_000,
      data: [{ b64_json: "generated-image" }],
    })
    expect(debugJsonAsyncMock).toHaveBeenCalledTimes(1)
    expect(debugJsonAsyncMock.mock.calls[0]?.[1]).toBe(
      "images.generations.codex.request",
    )
    expect(debugValues).toEqual([{ body: JSON.stringify(payload) }])
  })

  test("does not expose image endpoints over GET", async () => {
    const response = await createApp().request("/images/generations")

    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("returns 404 when the Codex provider is unavailable", async () => {
    codexProviderConfig = null

    const response = await createApp().request("/images/edits", {
      method: "POST",
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: {
        message: "Provider 'codex' not found or disabled",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("supports the provider-scoped images generations route", async () => {
    const payload = { model: "gpt-image-1", prompt: "provider path" }

    const response = await createApp().request(
      "/codex/v1/images/generations?output=base64",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    )

    expect(response.status).toBe(200)
    const [url] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations?output=base64",
    )
  })

  test("cleans staged provider edits immediately when the model is missing", async () => {
    const cleanup = mock(() => Promise.resolve())
    const scheduleCleanup = mock(() => {})
    imageEditsRouteDependencies.stageMultipartBodyToDisk = () =>
      Promise.resolve({
        cleanup,
        directory: "unused",
        formData: new FormData(),
        scheduleCleanup,
      })

    const response = await createApp().request("/openrouter/v1/images/edits", {
      method: "POST",
      body: new FormData(),
    })

    expect(response.status).toBe(400)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(scheduleCleanup).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects Claude models on provider-scoped image routes", async () => {
    const response = await createApp().request(
      "/openrouter/v1/images/generations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "CLAUDE-image-1",
          prompt: "blocked",
        }),
      },
    )

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rebuilds provider generation bodies with one validated model", async () => {
    const response = await createApp().request(
      "/openrouter/v1/images/generations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"claude-image-1","model":"gpt-image-2","prompt":"safe"}',
      },
    )

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(await new Response(init?.body).json()).toEqual({
      model: "gpt-image-2",
      prompt: "safe",
    })
  })

  test("proxies non-codex providers on the provider-scoped images route", async () => {
    const payload = { model: "gpt-image-1", prompt: "generic provider image" }

    const response = await createApp().request(
      "/openrouter/v1/images/generations?output=base64",
      {
        method: "POST",
        headers: {
          accept: "*/*",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://openrouter.example/v1/images/generations?output=base64",
    )
    expect(init?.method).toBe("POST")
    expect((init as StreamingRequestInit | undefined)?.duplex).toBe("half")
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer openrouter-key")
    expect(headers.get("content-type")).toBe("application/json")
    expect(await new Response(init?.body).json()).toEqual(payload)
  })

  test("forwards one validated model in provider image edits", async () => {
    const formData = new FormData()
    formData.append("model", "gpt-image-2")
    formData.append("model", "claude-image-1")
    formData.set("prompt", "generic edit")
    formData.set(
      "image",
      new Blob(["source-image-bytes"], { type: "image/png" }),
      "source.png",
    )

    const response = await createApp().request("/openrouter/v1/images/edits", {
      method: "POST",
      body: formData,
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)
    const forwardedFormData = await new Response(init?.body, {
      headers,
    }).formData()
    expect(forwardedFormData.getAll("model")).toEqual(["gpt-image-2"])
  })

  test("preserves multipart content-type for non-codex provider image edits", async () => {
    const formData = new FormData()
    formData.set("model", "gpt-image-2")
    formData.set("prompt", "generic edit")
    formData.set(
      "image",
      new Blob(["source-image-bytes"], { type: "image/png" }),
      "source.png",
    )

    const response = await createApp().request("/openrouter/v1/images/edits", {
      method: "POST",
      body: formData,
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://openrouter.example/v1/images/edits")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer openrouter-key")
    expect(headers.get("content-type")).toStartWith(
      "multipart/form-data; boundary=",
    )
  })
})

test("server registers unversioned, v1, and provider Codex media routes", () => {
  const postPaths = new Set(
    server.routes
      .filter((route) => route.method === "POST")
      .map((route) => route.path),
  )

  const expectedPaths = [
    "/alpha/search",
    "/v1/alpha/search",
    "/images/generations",
    "/images/edits",
    "/v1/images/generations",
    "/v1/images/edits",
    "/:provider/v1/alpha/search",
    "/:provider/v1/images/generations",
    "/:provider/v1/images/edits",
    "/:provider/v1/responses",
  ]
  for (const path of expectedPaths) {
    expect(postPaths.has(path)).toBe(true)
  }
})
