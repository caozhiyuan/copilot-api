import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { existsSync } from "node:fs"

import type { ResolvedProviderConfig } from "~/lib/config"

const actualConfigModule = await import("~/lib/config")
const actualTokenModule = await import("~/lib/token")

let codexProviderConfig: ResolvedProviderConfig | null = null
let openrouterProviderConfig: ResolvedProviderConfig | null = null
let xaiProviderConfig: ResolvedProviderConfig | null = null
let modelMappings: Record<string, string> = {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: (provider: string) => {
    if (provider === "codex") return codexProviderConfig
    if (provider === "openrouter") return openrouterProviderConfig
    if (provider === "xai") return xaiProviderConfig
    return null
  },
  getRawProviderConfig: (provider: string) => {
    if (provider === "codex") return codexProviderConfig
    if (provider === "openrouter") return openrouterProviderConfig
    if (provider === "xai") return xaiProviderConfig
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
const { imageRouteDependencies, imageRoutes } = await import(
  "~/routes/images/route"
)
const { providerImageRoutes } = await import("~/routes/provider/images/route")
const { multipartEditDependencies } = await import(
  "~/routes/images/multipart-edits"
)
const { server } = await import("~/server")
const { createMediaStudioClient } = await import(
  "../desktop/electron/media-studio"
)

const originalDebugJsonAsync = imageRouteDependencies.debugJsonAsync
const originalResolveMappedModel = imageRouteDependencies.resolveMappedModel
const originalResolveProviderConfig =
  imageRouteDependencies.resolveProviderConfig
const originalGetImageEditModel = imageRouteDependencies.getImageEditModel
const originalGetImageGenerationModel =
  imageRouteDependencies.getImageGenerationModel
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
const originalStageMultipart =
  multipartEditDependencies.stageMultipartBodyToDisk
let stagedUploads: Array<Awaited<ReturnType<typeof originalStageMultipart>>> =
  []
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
  app.route("/:provider/images", providerImageRoutes)
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
  xaiProviderConfig = {
    apiKey: "xai-key",
    authType: "authorization",
    baseUrl: "https://api.x.ai",
    name: "xai",
    type: "openai-responses",
  }
  modelMappings = {}
  state.codexAccessToken = "codex-access-token"
  state.codexAccountId = "account-123"
  state.verbose = false
  fetchMock.mockClear()
  debugJsonAsyncMock.mockClear()
  debugValues = []
  stagedUploads = []
  multipartEditDependencies.stageMultipartBodyToDisk = async (...args) => {
    const staged = await originalStageMultipart(...args)
    stagedUploads.push(staged)
    return staged
  }
  imageRouteDependencies.debugJsonAsync = debugJsonAsyncMock
  imageRouteDependencies.resolveMappedModel = (model) =>
    modelMappings[model] ?? model
  imageRouteDependencies.resolveProviderConfig = (provider) =>
    Promise.resolve(
      provider === "codex" ? codexProviderConfig
      : provider === "openrouter" ? openrouterProviderConfig
      : provider === "xai" ? xaiProviderConfig
      : null,
    )
  imageRouteDependencies.getImageEditModel = () => ({
    status: "disabled" as const,
  })
  imageRouteDependencies.getImageGenerationModel = () => ({
    status: "disabled" as const,
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(async () => {
  await Promise.all(stagedUploads.map((staged) => staged.cleanup()))
  multipartEditDependencies.stageMultipartBodyToDisk = originalStageMultipart
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.codexAccessToken = undefined
  state.codexAccountId = undefined
  state.verbose = false
  openrouterProviderConfig = null
  imageRouteDependencies.debugJsonAsync = originalDebugJsonAsync
  imageRouteDependencies.resolveMappedModel = originalResolveMappedModel
  imageRouteDependencies.resolveProviderConfig = originalResolveProviderConfig
  imageRouteDependencies.getImageEditModel = originalGetImageEditModel
  imageRouteDependencies.getImageGenerationModel =
    originalGetImageGenerationModel
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
  test.each(["default", "codex"] as const)(
    "sends desktop %s image edits through an HTTP gateway as JSON",
    async (provider) => {
      const app = createApp()
      const gateway = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => app.fetch(request),
      })
      try {
        let upstreamPayload: unknown
        fetchMock.mockImplementationOnce(async (_url, init) => {
          upstreamPayload = await new Response(init?.body).json()
          return Response.json({ data: [{ b64_json: "iVBORw==" }] })
        })
        const client = createMediaStudioClient({
          getBaseUrl: () => gateway.url.origin,
          getHeaders: () => Promise.resolve({ "x-api-key": "gateway-key" }),
          fetch: originalFetch,
        })
        const result = await client.createImages("desktop-edit", {
          provider,
          mode: "edit",
          model: "gpt-image-2",
          prompt: "make the sky purple",
          n: 1,
          size: "auto",
          quality: "auto",
          images: [
            {
              name: "source.png",
              type: "image/png",
              bytes: new Uint8Array([137, 80, 78, 71]),
            },
          ],
        })
        expect(result[0]?.url).toBe("data:image/png;base64,iVBORw==")
        const [url, init] = fetchMock.mock.calls[0] ?? []
        expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits")
        expect(new Headers(init?.headers).get("content-type")).toBe(
          "application/json",
        )
        expect(new Headers(init?.headers).get("x-api-key")).toBeNull()
        expect(upstreamPayload).toEqual({
          model: "gpt-image-2",
          prompt: "make the sky purple",
          n: 1,
          size: "auto",
          quality: "auto",
          images: [{ image_url: "data:image/png;base64,iVBORw==" }],
        })
      } finally {
        await gateway.stop(true)
      }
    },
  )

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

  test("rewrites a mapped JSON generation model before forwarding to Codex", async () => {
    modelMappings = {
      "image-model": "gpt-image-2",
    }

    const response = await createApp().request("/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "image-model",
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
      "image-model": "openrouter/black-forest-labs/flux-1.1-pro",
    }

    const response = await createApp().request(
      "/v1/images/generations?output=base64",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "image-model",
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
      model: "black-forest-labs/flux-1.1-pro",
      prompt: "mapped provider image",
    })
  })

  test("forwards the original model to Codex when the mapped provider is unavailable", async () => {
    openrouterProviderConfig = null
    modelMappings = {
      "image-model": "openrouter/black-forest-labs/flux-1.1-pro",
    }

    const response = await createApp().request("/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "image-model",
        prompt: "fallback to original model",
      }),
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(await new Response(init?.body).json()).toEqual({
      model: "image-model",
      prompt: "fallback to original model",
    })
  })

  test.each(["/images/edits", "/v1/images/edits", "/codex/v1/images/edits"])(
    "forwards desktop JSON image edits unchanged on %s",
    async (path) => {
      state.verbose = true
      const payload = {
        model: "gpt-image-2",
        prompt: "make the sky purple",
        n: 1,
        size: "auto",
        quality: "auto",
        images: [{ image_url: "data:image/png;base64,cG5n" }],
      }
      const body = JSON.stringify(payload, null, 2)
      const response = await createApp().request(`${path}?output=base64`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-client-request-id": "edit-request",
        },
        body,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        data: [{ b64_json: "generated-image" }],
      })
      const [url, init] = fetchMock.mock.calls[0] ?? []
      expect(url).toBe(
        "https://chatgpt.com/backend-api/codex/images/edits?output=base64",
      )
      const headers = new Headers(init?.headers)
      expect(headers.get("content-type")).toBe("application/json")
      expect(headers.get("x-client-request-id")).toBe("edit-request")
      expect(await new Response(init?.body).text()).toBe(body)
      expect(debugJsonAsyncMock).not.toHaveBeenCalled()
    },
  )

  test.each([
    { requested: "edit-model", mapped: "gpt-image-2", expected: "gpt-image-2" },
    {
      requested: "edit-model",
      mapped: "codex/gpt-image-2",
      expected: "gpt-image-2",
    },
    {
      requested: "codex/gpt-image-2",
      mapped: "codex/gpt-image-2",
      expected: "gpt-image-2",
    },
    {
      requested: "edit-model",
      mapped: "missing/gpt-image-2",
      expected: "edit-model",
    },
  ])(
    "applies JSON edit model mappings and provider aliases %j",
    async ({ requested, mapped, expected }) => {
      modelMappings = { [requested]: mapped }
      const payload = {
        model: requested,
        prompt: "mapped edit",
        images: [{ image_url: "https://example.com/source.png" }],
        mask: { file_id: "file-mask" },
        stream: true,
      }
      const response = await createApp().request("/v1/images/edits", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(JSON.stringify(payload).length),
        },
        body: JSON.stringify(payload),
      })

      expect(response.status).toBe(200)
      const [url, init] = fetchMock.mock.calls[0] ?? []
      expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits")
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/json",
      )
      expect(new Headers(init?.headers).get("content-length")).toBeNull()
      expect(await new Response(init?.body).json()).toEqual({
        ...payload,
        model: expected,
      })
    },
  )

  test.each(["/v1/images/edits", "/codex/v1/images/edits"])(
    "preserves image ordering, masks and typed JSON options on %s",
    async (path) => {
      const payload = {
        model: "gpt-image-2",
        prompt: "combine images",
        images: [
          { image_url: "data:image/png;base64,Zmlyc3Q=" },
          { image_url: "https://example.com/second.png" },
          { file_id: "file-third" },
        ],
        mask: { image_url: "data:image/png;base64,bWFzaw==" },
        n: 2,
        stream: true,
        partial_images: 1,
        output_compression: 85,
        output_format: "webp",
        input_fidelity: "high",
        response_format: "b64_json",
        background: "transparent",
        safety_identifier: "safety-id",
        user: "user-id",
      }
      const response = await createApp().request(path, {
        method: "POST",
        headers: { "content-type": "Application/JSON; charset=UTF-8" },
        body: JSON.stringify(payload),
      })
      expect(response.status).toBe(200)
      const [, init] = fetchMock.mock.calls[0] ?? []
      expect(await new Response(init?.body).json()).toEqual(payload)
    },
  )

  test("routes a mapped JSON edit model to its configured provider", async () => {
    modelMappings = {
      "edit-model": "openrouter/black-forest-labs/flux-kontext-pro",
    }
    const payload = {
      model: "edit-model",
      prompt: "mapped provider edit",
      images: [{ image_url: "data:image/png;base64,cG5n" }],
    }
    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://openrouter.example/v1/images/edits")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer openrouter-key")
    expect(headers.get("content-type")).toBe("application/json")
    expect(await new Response(init?.body).json()).toEqual({
      ...payload,
      model: "black-forest-labs/flux-kontext-pro",
    })
  })

  test("forwards a JSON edit without a model to Codex", async () => {
    const payload = {
      prompt: "no model field",
      images: [{ file_id: "file-image" }],
    }
    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits")
    expect(await new Response(init?.body).json()).toEqual(payload)
  })

  test.each([
    "/images/edits",
    "/v1/images/edits",
    "/codex/images/edits",
    "/codex/v1/images/edits",
  ])("converts multipart image edits to Codex JSON on %s", async (path) => {
    const form = new FormData()
    form.set("model", "gpt-image-2")
    form.set("image[]", new File(["png"], "source.png", { type: "image/png" }))
    const response = await createApp().request(`${path}?output=base64`, {
      method: "POST",
      headers: { "x-client-request-id": "multipart-edit" },
      body: form,
    })
    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://chatgpt.com/backend-api/codex/images/edits?output=base64",
    )
    const headers = new Headers(init?.headers)
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("content-length")).toBeNull()
    expect(headers.get("x-client-request-id")).toBe("multipart-edit")
    expect(await new Response(init?.body).json()).toEqual({
      model: "gpt-image-2",
      images: [{ image_url: "data:image/png;base64,cG5n" }],
    })
    expect(stagedUploads).toHaveLength(1)
    expect(existsSync(stagedUploads[0].directory)).toBe(false)
  })

  test.each(["/v1/images/edits", "/codex/v1/images/edits"])(
    "rejects non-JSON image edit content types on %s",
    async (path) => {
      const response = await createApp().request(path, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "raw-bytes",
      })
      expect(response.status).toBe(415)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test("forwards invalid edit JSON for upstream validation", async () => {
    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    })
    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(await new Response(init?.body).text()).toBe("not-json")
  })

  test("reports edit request body read failures", async () => {
    const request = new Request("http://localhost/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error("upload interrupted"))
        },
      }),
      duplex: "half",
    } as StreamingRequestInit)
    const response = await createApp().request(request)
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: { message: "upload interrupted" },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each(["/v1/images/edits", "/codex/v1/images/edits"])(
    "preserves Codex JSON edit errors on %s",
    async (path) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ detail: "Invalid image reference" }, { status: 400 }),
      )
      const response = await createApp().request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt: "edit",
          images: [],
        }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        detail: "Invalid image reference",
      })
    },
  )

  test.each(["/v1/images/edits", "/codex/v1/images/edits"])(
    "reports Codex edit network failures on %s",
    async (path) => {
      fetchMock.mockRejectedValueOnce(new Error("Codex unavailable"))
      const response = await createApp().request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({
        error: { message: "Codex unavailable" },
      })
    },
  )

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
      "image-model": "gpt-image-2",
    }
    const encoder = new TextEncoder()
    const body = new Uint8Array([
      ...encoder.encode('{"model":"image-model","prompt":"'),
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
      headers: { "content-type": "application/json" },
      body: "{}",
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
    const payload = { prompt: "provider path" }

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

  test("returns 404 when the provider-scoped Codex provider is disabled", async () => {
    codexProviderConfig = null
    const response = await createApp().request("/codex/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
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

  test("proxies non-codex providers on the provider-scoped images route", async () => {
    const payload = { prompt: "generic provider image" }

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

describe("multipart image edit routing", () => {
  function editForm(model?: string) {
    const form = new FormData()
    if (model !== undefined) form.set("model", model)
    form.set("prompt", "make it blue")
    form.set("image", new File(["source"], "source.png", { type: "image/png" }))
    return form
  }

  test.each([
    {
      path: "/v1/images/edits",
      model: "gpt-image-2",
      upstream: "https://chatgpt.com/backend-api/codex/images/edits",
    },
    {
      path: "/xai/v1/images/edits",
      model: "grok-imagine-image-2.0",
      upstream: "https://api.x.ai/v1/images/edits",
    },
  ])(
    "accepts multipart uploads over HTTP on $path",
    async ({ path, model, upstream }) => {
      const app = createApp()
      const gateway = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: app.fetch,
      })
      try {
        const response = await originalFetch(
          `http://127.0.0.1:${gateway.port}${path}`,
          { method: "POST", body: editForm(model) },
        )
        expect(response.status).toBe(200)
        await response.arrayBuffer()
        const [url, init] = fetchMock.mock.calls[0] ?? []
        expect(url).toBe(upstream)
        expect(new Headers(init?.headers).get("content-type")).toBe(
          "application/json",
        )
        expect(await new Response(init?.body).json()).toMatchObject({
          model,
          prompt: "make it blue",
        })
        expect(stagedUploads).toHaveLength(1)
        expect(existsSync(stagedUploads[0].directory)).toBe(false)
      } finally {
        await gateway.stop(true)
      }
    },
  )

  test.each([
    {
      requested: "image-model",
      mapped: "gpt-image-2",
      expected: "gpt-image-2",
      provider: "codex",
    },
    {
      requested: "image-model",
      mapped: "codex/gpt-image-2",
      expected: "gpt-image-2",
      provider: "codex",
    },
    {
      requested: "codex/gpt-image-2",
      mapped: "codex/gpt-image-2",
      expected: "gpt-image-2",
      provider: "codex",
    },
    {
      requested: "image-model",
      mapped: "missing/gpt-image-2",
      expected: "image-model",
      provider: "codex",
    },
    {
      requested: "image-model",
      mapped: "xai/grok-imagine-image-2.0",
      expected: "grok-imagine-image-2.0",
      provider: "xai",
    },
    {
      requested: "xai/grok-imagine-image-2.0",
      mapped: "xai/grok-imagine-image-2.0",
      expected: "grok-imagine-image-2.0",
      provider: "xai",
    },
  ])(
    "routes multipart model mappings $mapped to $provider",
    async ({ requested, mapped, expected, provider }) => {
      modelMappings = { [requested]: mapped }
      const response = await createApp().request("/v1/images/edits", {
        method: "POST",
        body: editForm(requested),
      })
      expect(response.status).toBe(200)
      const [url, init] = fetchMock.mock.calls[0] ?? []
      expect(url).toBe(
        provider === "codex" ?
          "https://chatgpt.com/backend-api/codex/images/edits"
        : "https://api.x.ai/v1/images/edits",
      )
      const payload: unknown = await new Response(init?.body).json()
      expect(payload).toEqual(
        provider === "codex" ?
          {
            model: expected,
            prompt: "make it blue",
            images: [{ image_url: "data:image/png;base64,c291cmNl" }],
          }
        : {
            model: expected,
            prompt: "make it blue",
            image: { type: "image_url", url: "data:image/png;base64,c291cmNl" },
            response_format: "b64_json",
          },
      )
      expect(stagedUploads).toHaveLength(1)
      expect(existsSync(stagedUploads[0].directory)).toBe(false)
    },
  )

  test("forwards multipart without a model to Codex JSON", async () => {
    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      body: editForm(),
    })
    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(await new Response(init?.body).json()).toEqual({
      prompt: "make it blue",
      images: [{ image_url: "data:image/png;base64,c291cmNl" }],
    })
  })

  test("keeps mapped custom-provider uploads as multipart", async () => {
    modelMappings = { "image-model": "openrouter/other-model" }
    let forwardedModel: unknown
    let forwardedImage: string | undefined
    fetchMock.mockImplementationOnce(async (_url, init) => {
      expect(existsSync(stagedUploads[0].directory)).toBe(true)
      const form = await new Response(init?.body).formData()
      forwardedModel = form.get("model")
      const image = form.get("image")
      if (!image || typeof image === "string")
        throw new Error("Expected uploaded file")
      forwardedImage = await image.text()
      return Response.json({ data: [] })
    })
    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      body: editForm("image-model"),
    })
    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://openrouter.example/v1/images/edits")
    expect(new Headers(init?.headers).get("content-type")).toStartWith(
      "multipart/form-data; boundary=",
    )
    expect(forwardedModel).toBe("other-model")
    expect(forwardedImage).toBe("source")
  })

  test.each(["/xai/images/edits", "/xai/v1/images/edits"])(
    "converts provider-scoped multipart xAI edits on %s",
    async (path) => {
      const form = editForm("grok-imagine-image-2.0")
      form.append("image[]", "https://example.com/second.png")
      const response = await createApp().request(`${path}?client=test`, {
        method: "POST",
        body: form,
      })
      expect(response.status).toBe(200)
      const [url, init] = fetchMock.mock.calls[0] ?? []
      expect(url).toBe("https://api.x.ai/v1/images/edits?client=test")
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe("Bearer xai-key")
      expect(headers.get("content-type")).toBe("application/json")
      expect(await new Response(init?.body).json()).toEqual({
        model: "grok-imagine-image-2.0",
        prompt: "make it blue",
        response_format: "b64_json",
        images: [
          { type: "image_url", url: "data:image/png;base64,c291cmNl" },
          { type: "image_url", url: "https://example.com/second.png" },
        ],
      })
      expect(existsSync(stagedUploads[0].directory)).toBe(false)
    },
  )

  test("preserves native provider-scoped xAI JSON unchanged", async () => {
    const body = JSON.stringify(
      {
        model: "grok-imagine-image-2.0",
        prompt: "edit",
        image: { type: "image_url", url: "https://example.com/source.png" },
        response_format: "url",
        custom: "value",
      },
      null,
      2,
    )
    const response = await createApp().request("/xai/v1/images/edits", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    })
    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(await new Response(init?.body).text()).toBe(body)
    expect(stagedUploads).toHaveLength(0)
  })

  test("configured xAI edit model overrides multipart models and mappings", async () => {
    imageRouteDependencies.getImageEditModel = () => ({
      status: "xai",
      model: "grok-imagine-image-2.0",
    })
    modelMappings = { "image-model": "openrouter/ignored-model" }
    const form = editForm("image-model")
    form.append("image[]", "https://example.com/second.png")
    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      body: form,
    })
    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://api.x.ai/v1/images/edits")
    expect(await new Response(init?.body).json()).toMatchObject({
      model: "grok-imagine-image-2.0",
      images: [
        { type: "image_url", url: "data:image/png;base64,c291cmNl" },
        { type: "image_url", url: "https://example.com/second.png" },
      ],
    })
  })

  test.each(["configured", "mapped", "scoped"])(
    "rejects multipart masks for %s xAI edits",
    async (mode) => {
      if (mode === "configured")
        imageRouteDependencies.getImageEditModel = () => ({
          status: "xai",
          model: "grok-imagine-image-2.0",
        })
      if (mode === "mapped")
        modelMappings = {
          "grok-imagine-image-2.0": "xai/grok-imagine-image-2.0",
        }
      const form = editForm("grok-imagine-image-2.0")
      form.set("mask", new File(["mask"], "mask.png", { type: "image/png" }))
      const response = await createApp().request(
        mode === "scoped" ? "/xai/v1/images/edits" : "/v1/images/edits",
        { method: "POST", body: form },
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "xAI image edits do not support mask",
        },
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(existsSync(stagedUploads[0].directory)).toBe(false)
    },
  )

  test.each([
    "/v1/images/edits",
    "/codex/v1/images/edits",
    "/xai/v1/images/edits",
  ])(
    "rejects oversized and malformed multipart uploads on %s",
    async (path) => {
      multipartEditDependencies.stageMultipartBodyToDisk = (
        body,
        type,
        _limits,
        signal,
      ) => originalStageMultipart(body, type, { maxBodySizeBytes: 16 }, signal)
      let response = await createApp().request(path, {
        method: "POST",
        body: editForm("gpt-image-2"),
      })
      expect(response.status).toBe(413)
      expect(await response.json()).toMatchObject({
        error: { type: "invalid_request_error" },
      })
      multipartEditDependencies.stageMultipartBodyToDisk =
        originalStageMultipart
      response = await createApp().request(path, {
        method: "POST",
        body: "broken",
        headers: { "content-type": "multipart/form-data" },
      })
      expect(response.status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test("cancels the Codex upstream request after multipart conversion", async () => {
    const controller = new AbortController()
    let upstreamSignal: AbortSignal | null | undefined
    fetchMock.mockImplementationOnce((_url, init) => {
      expect(existsSync(stagedUploads[0].directory)).toBe(false)
      upstreamSignal = init?.signal
      const reason = new Error("edit cancelled")
      reason.name = "AbortError"
      controller.abort(reason)
      return Promise.reject(reason)
    })
    const response = await createApp().request(
      new Request("http://localhost/v1/images/edits", {
        method: "POST",
        body: editForm("gpt-image-2"),
        signal: controller.signal,
      }),
    )
    expect(response.status).toBe(499)
    expect(upstreamSignal?.aborted).toBe(true)
  })
})

describe("xAI image routes", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  )

  test.each([
    { operation: "generations", option: "n" },
    { operation: "generations", option: "response_format" },
    { operation: "edits", option: "n" },
    { operation: "edits", option: "response_format" },
  ] as const)(
    "treats nullable image options as omitted: %j",
    async ({ operation, option }) => {
      imageRouteDependencies.getImageGenerationModel = () => ({
        model: "grok-imagine-image-2.0",
        status: "xai",
      })
      imageRouteDependencies.getImageEditModel =
        imageRouteDependencies.getImageGenerationModel
      const imageUrl = "https://example.com/source.png"
      const response = await createApp().request(`/v1/images/${operation}`, {
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt: "ok",
          [option]: null,
          ...(operation === "edits" ? { image: imageUrl } : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] ?? []
      expect(url).toBe(`https://api.x.ai/v1/images/${operation}`)
      expect(await new Response(init?.body).json()).toEqual({
        model: "grok-imagine-image-2.0",
        prompt: "ok",
        response_format: "b64_json",
        ...(operation === "edits" ?
          { image: { type: "image_url", url: imageUrl } }
        : {}),
      })
      expect(await response.json()).toMatchObject({
        data: [{ b64_json: "generated-image" }],
      })
    },
  )

  test("keeps requested URL output without a second upstream request", async () => {
    imageRouteDependencies.getImageGenerationModel = () => ({
      model: "grok-imagine-image-2.0",
      status: "xai",
    })
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json({
          created: null,
          data: [{ url: "https://imgen.x.ai/output.png" }],
        }),
      ),
    )
    const response = await createApp().request("/v1/images/generations", {
      body: JSON.stringify({ prompt: "ok", response_format: "url" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await response.json()).toMatchObject({
      data: [{ url: "https://imgen.x.ai/output.png" }],
    })
  })

  test("normalizes URL-only edit output to base64 and strips upstream credentials from the download", async () => {
    imageRouteDependencies.getImageEditModel = () => ({
      model: "grok-imagine-image-2.0",
      status: "xai",
    })
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json({ data: [{ url: "https://imgen.x.ai/output.png" }] }),
      ),
    )
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(png, { headers: { "content-type": "image/png" } }),
      ),
    )
    const response = await createApp().request("/v1/images/edits", {
      body: JSON.stringify({
        images: [
          { image_url: "data:image/png;base64," + png.toString("base64") },
        ],
        prompt: "ok",
      }),
      headers: {
        authorization: "Bearer client-token",
        "content-type": "application/json",
      },
      method: "POST",
    })
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[1] ?? []
    expect(url).toBe("https://imgen.x.ai/output.png")
    expect(new Headers(init?.headers).has("authorization")).toBe(false)
    const [, editInit] = fetchMock.mock.calls[0] ?? []
    expect(await new Response(editInit?.body).json()).toMatchObject({
      image: {
        type: "image_url",
        url: "data:image/png;base64," + png.toString("base64"),
      },
      model: "grok-imagine-image-2.0",
    })
    expect(await response.json()).toMatchObject({
      data: [{ b64_json: png.toString("base64") }],
    })
  })

  test("returns 502 when a requested base64 image cannot be retrieved", async () => {
    imageRouteDependencies.getImageGenerationModel = () => ({
      model: "grok-imagine-image-2.0",
      status: "xai",
    })
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json({ data: [{ url: "https://imgen.x.ai/output.png" }] }),
      ),
    )
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    )
    const response = await createApp().request("/v1/images/generations", {
      body: JSON.stringify({ prompt: "ok" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: { type: "upstream_error" },
    })
  })

  test("propagates cancellation to provider image generation", async () => {
    const controller = new AbortController()
    let upstreamSignal: AbortSignal | null | undefined
    imageRouteDependencies.getImageGenerationModel = () => ({
      model: "grok-imagine-image-2.0",
      status: "xai",
    })
    fetchMock.mockImplementationOnce((_url, init) => {
      upstreamSignal = init?.signal
      const reason = new Error("The operation was aborted")
      reason.name = "AbortError"
      controller.abort(reason)
      return Promise.reject(reason)
    })
    const response = await createApp().request(
      new Request("http://localhost/v1/images/generations", {
        body: JSON.stringify({ prompt: "ok" }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      }),
    )
    expect(response.status).toBe(499)
    expect(upstreamSignal?.aborted).toBe(true)
  })

  test("translates generation to the configured xAI model", async () => {
    imageRouteDependencies.getImageGenerationModel = () => ({
      model: "grok-imagine-image-2.0",
      status: "xai",
    })
    modelMappings = { "gpt-image-1": "openrouter/other-image" }
    xaiProviderConfig = {
      ...xaiProviderConfig!,
      baseUrl: "https://cli-chat-proxy.grok.com",
    }

    const response = await createApp().request(
      "/v1/images/generations?output=base64",
      {
        method: "POST",
        headers: {
          authorization: "Bearer client-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          background: "transparent",
          model: "gpt-image-1",
          prompt: "a red apple",
          quality: "high",
          size: "1024x1024",
        }),
      },
    )

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://cli-chat-proxy.grok.com/v1/images/generations?output=base64",
    )
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer xai-key")
    expect(headers.get("content-type")).toBe("application/json")
    expect(await new Response(init?.body).json()).toEqual({
      aspect_ratio: "1:1",
      model: "grok-imagine-image-2.0",
      prompt: "a red apple",
      quality: "medium",
      resolution: "1k",
      response_format: "b64_json",
    })
  })

  test("rejects a non-xai generation model without calling upstream", async () => {
    imageRouteDependencies.getImageGenerationModel = () => ({
      message:
        "imageGenerationModel only supports an xai/model alias, received 'gpt-image-1'",
      status: "invalid",
    })

    const response = await createApp().request("/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-1", prompt: "a red apple" }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message:
          "imageGenerationModel only supports an xai/model alias, received 'gpt-image-1'",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("returns 404 when the xAI provider is not configured", async () => {
    xaiProviderConfig = null
    imageRouteDependencies.getImageGenerationModel = () => ({
      model: "grok-imagine-image-2.0",
      status: "xai",
    })

    const response = await createApp().request("/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a red apple" }),
    })

    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects a generation body that is not JSON", async () => {
    imageRouteDependencies.getImageGenerationModel = () => ({
      model: "grok-imagine-image-2.0",
      status: "xai",
    })

    const response = await createApp().request("/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "Image generation body must be JSON",
        type: "invalid_request_error",
      },
    })
  })

  test("keeps JSON edits on Codex when only generation is configured", async () => {
    imageRouteDependencies.getImageGenerationModel = () => ({
      model: "grok-imagine-image-2.0",
      status: "xai",
    })
    const payload = {
      model: "gpt-image-2",
      prompt: "unchanged edit",
      images: [
        { image_url: "data:image/png;base64," + png.toString("base64") },
      ],
    }
    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits")
    expect(await new Response(init?.body).json()).toEqual(payload)
  })

  test("translates a JSON edit into the configured xAI protocol", async () => {
    imageRouteDependencies.getImageEditModel = () => ({
      model: "grok-imagine-image",
      status: "xai",
    })
    modelMappings = { "gpt-image-2": "codex/ignored" }
    const imageUrl = "data:image/png;base64," + png.toString("base64")
    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt: "make it blue",
        images: [{ image_url: imageUrl }],
      }),
    })
    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://api.x.ai/v1/images/edits")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer xai-key")
    expect(headers.get("content-type")).toBe("application/json")
    expect(await new Response(init?.body).json()).toEqual({
      image: { type: "image_url", url: imageUrl },
      model: "grok-imagine-image",
      prompt: "make it blue",
      response_format: "b64_json",
    })
  })

  test("converts multipart edits when an xAI edit model is configured", async () => {
    imageRouteDependencies.getImageEditModel = () => ({
      model: "grok-imagine-image",
      status: "xai",
    })
    const form = new FormData()
    form.set("prompt", "edit this image")
    form.set("model", "ignored-model")
    form.set("image", "https://example.com/source.png")
    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      body: form,
    })
    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://api.x.ai/v1/images/edits")
    expect(await new Response(init?.body).json()).toEqual({
      model: "grok-imagine-image",
      prompt: "edit this image",
      image: { type: "image_url", url: "https://example.com/source.png" },
      response_format: "b64_json",
    })
  })

  test("rejects invalid image edit model configuration", async () => {
    imageRouteDependencies.getImageEditModel = () => ({
      message: "Invalid image edit model",
      status: "invalid",
    })
    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "Invalid image edit model",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("translates a JSON edit and rejects a mask", async () => {
    imageRouteDependencies.getImageEditModel = () => ({
      model: "grok-imagine-image-2.0",
      status: "xai",
    })

    const jsonResponse = await createApp().request("/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image: { url: "https://example.com/cat.png" },
        model: "gpt-image-1",
        prompt: "paint it",
      }),
    })
    expect(jsonResponse.status).toBe(200)
    const [, jsonInit] = fetchMock.mock.calls[0] ?? []
    expect(await new Response(jsonInit?.body).json()).toEqual({
      image: { type: "image_url", url: "https://example.com/cat.png" },
      model: "grok-imagine-image-2.0",
      prompt: "paint it",
      response_format: "b64_json",
    })

    fetchMock.mockClear()
    const maskResponse = await createApp().request("/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "cut it",
        images: [{ image_url: "https://example.com/cat.png" }],
        mask: { image_url: "https://example.com/mask.png" },
      }),
    })
    expect(maskResponse.status).toBe(400)
    expect(await maskResponse.json()).toEqual({
      error: {
        message: "xAI image edits do not support mask",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects an edit body that is not JSON when the edit model is xAI", async () => {
    imageRouteDependencies.getImageEditModel = () => ({
      model: "grok-imagine-image",
      status: "xai",
    })

    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "Image edit body must be JSON",
        type: "invalid_request_error",
      },
    })
  })
})
