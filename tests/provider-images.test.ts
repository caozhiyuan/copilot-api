import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { brotliCompressSync, gzipSync } from "node:zlib"

import type { ResolvedProviderConfig } from "../src/lib/config"
import { zstdDecompressionMiddleware } from "../src/lib/zstd-request"

const actualConfigModule = await import("../src/lib/config")

let providerConfig: ResolvedProviderConfig | null = null
let localApiKeys: Array<string> = []

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getConfig: () => ({ auth: { apiKeys: localApiKeys } }),
  getProviderConfig: () => providerConfig,
}))

const { createAuthMiddleware } = await import("../src/lib/request-auth")
const { providerImageRoutes } = await import(
  "../src/routes/provider/images/route"
)

const originalFetch = globalThis.fetch

type StreamingRequestInit = RequestInit & {
  duplex?: "half"
}

let upstreamResponse: Response
let upstreamError: Error | null = null
let capturedUrl = ""
let capturedHeaders = new Headers()
let capturedBody = new Uint8Array()
let capturedDuplex: StreamingRequestInit["duplex"]

const fetchMock = mock(
  async (
    url: string | URL | Request,
    init?: StreamingRequestInit,
  ): Promise<Response> => {
    capturedUrl =
      typeof url === "string" ? url
      : url instanceof URL ? url.toString()
      : url.url
    capturedHeaders = new Headers(init?.headers)
    capturedDuplex = init?.duplex
    capturedBody =
      init?.body ?
        new Uint8Array(await new Response(init.body).arrayBuffer())
      : new Uint8Array()
    if (upstreamError) {
      throw upstreamError
    }
    return upstreamResponse.clone() as unknown as Response
  },
)

const createApp = () => {
  const app = new Hono()
  app.use(cors())
  app.use(
    "*",
    createAuthMiddleware({
      allowUnauthenticatedPaths: [],
    }),
  )
  app.use(zstdDecompressionMiddleware)
  app.route("/:provider/v1/images", providerImageRoutes)
  return app
}

const createProviderConfig = (
  overrides: Partial<ResolvedProviderConfig> = {},
): ResolvedProviderConfig => ({
  apiKey: "provider-key",
  authType: "authorization",
  baseUrl: "https://images.example/openai",
  imageEndpoints: ["generations", "edits"],
  name: "images",
  type: "openai-compatible",
  ...overrides,
})

beforeEach(() => {
  providerConfig = createProviderConfig()
  localApiKeys = ["local-client-key"]
  upstreamError = null
  upstreamResponse = Response.json(
    {
      created: 0,
      data: [{ b64_json: "encoded-image" }],
    },
    {
      headers: {
        "x-request-id": "upstream-request-id",
      },
    },
  )
  capturedUrl = ""
  capturedHeaders = new Headers()
  capturedBody = new Uint8Array()
  capturedDuplex = undefined
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfig = null
  localApiKeys = []
})

describe("provider Images API", () => {
  test("forwards image generation JSON with provider auth", async () => {
    const payload = {
      model: "gpt-image-2",
      prompt: "A red circle on white",
      quality: "low",
      size: "1024x1024",
    }

    const response = await createApp().request(
      "/images/v1/images/generations",
      {
        body: JSON.stringify(payload),
        headers: {
          accept: "application/json",
          authorization: "Bearer local-client-key",
          cookie: "session=do-not-forward",
          "content-type": "application/json",
          "user-agent": "image-client/test",
          "x-api-key": "local-client-key",
        },
        method: "POST",
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      created: 0,
      data: [{ b64_json: "encoded-image" }],
    })
    expect(response.headers.get("x-request-id")).toBe("upstream-request-id")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(capturedUrl).toBe(
      "https://images.example/openai/v1/images/generations",
    )
    expect(capturedHeaders.get("authorization")).toBe("Bearer provider-key")
    expect(capturedHeaders.get("x-api-key")).toBeNull()
    expect(capturedHeaders.get("cookie")).toBeNull()
    expect(capturedHeaders.get("content-type")).toBe("application/json")
    expect(capturedHeaders.get("accept")).toBe("application/json")
    expect(capturedHeaders.get("user-agent")).toBe("image-client/test")
    expect(capturedDuplex).toBe("half")
    expect(JSON.parse(new TextDecoder().decode(capturedBody))).toEqual(payload)
  })

  test("streams multipart image edits without changing fields or files", async () => {
    const firstImage = new Uint8Array([137, 80, 78, 71, 1])
    const secondImage = new Uint8Array([137, 80, 78, 71, 2])
    const maskImage = new Uint8Array([137, 80, 78, 71, 3])
    const formData = new FormData()
    formData.append("model", "gpt-image-2")
    formData.append("prompt", "Change only the background")
    formData.append(
      "image",
      new File([firstImage], "first.png", { type: "image/png" }),
    )
    formData.append(
      "image",
      new File([secondImage], "second.png", { type: "image/png" }),
    )
    formData.append(
      "mask",
      new File([maskImage], "mask.png", { type: "image/png" }),
    )

    const request = new Request("http://localhost/images/v1/images/edits", {
      body: formData,
      headers: {
        authorization: "Bearer local-client-key",
      },
      method: "POST",
    })
    const inboundContentType = request.headers.get("content-type")

    const response = await createApp().request(request)

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(capturedUrl).toBe("https://images.example/openai/v1/images/edits")
    expect(capturedHeaders.get("authorization")).toBe("Bearer provider-key")
    expect(capturedHeaders.get("content-type")).toBe(inboundContentType)
    expect(capturedHeaders.get("content-type")).toContain(
      "multipart/form-data; boundary=",
    )
    expect(capturedDuplex).toBe("half")

    const forwardedFormData = await new Response(capturedBody, {
      headers: {
        "content-type": capturedHeaders.get("content-type") ?? "",
      },
    }).formData()
    expect(forwardedFormData.get("model")).toBe("gpt-image-2")
    expect(forwardedFormData.get("prompt")).toBe("Change only the background")

    const forwardedImages = forwardedFormData.getAll(
      "image",
    ) as unknown as Array<File>
    expect(forwardedImages).toHaveLength(2)
    expect(forwardedImages.map((image) => image.name)).toEqual([
      "first.png",
      "second.png",
    ])
    expect(forwardedImages.map((image) => image.type)).toEqual([
      "image/png",
      "image/png",
    ])
    expect(new Uint8Array(await forwardedImages[0].arrayBuffer())).toEqual(
      firstImage,
    )
    expect(new Uint8Array(await forwardedImages[1].arrayBuffer())).toEqual(
      secondImage,
    )

    const forwardedMask = forwardedFormData.get("mask") as unknown as File
    expect(forwardedMask.name).toBe("mask.png")
    expect(forwardedMask.type).toBe("image/png")
    expect(new Uint8Array(await forwardedMask.arrayBuffer())).toEqual(maskImage)
  })

  test("preserves gzip and brotli request encodings", async () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ model: "gpt-image-2", prompt: "compressed" }),
    )
    const encodedBodies = [
      { body: gzipSync(payload), encoding: "gzip" },
      { body: brotliCompressSync(payload), encoding: "br" },
    ]

    for (const { body, encoding } of encodedBodies) {
      const response = await createApp().request(
        "/images/v1/images/generations",
        {
          body,
          headers: {
            authorization: "Bearer local-client-key",
            "content-encoding": encoding,
            "content-type": "application/json",
          },
          method: "POST",
        },
      )

      expect(response.status).toBe(200)
      expect(capturedHeaders.get("content-encoding")).toBe(encoding)
      expect(capturedBody).toEqual(new Uint8Array(body))
    }

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("forwards decompressed zstd bodies without the encoding header", async () => {
    const payload = JSON.stringify({
      model: "gpt-image-2",
      prompt: "compressed",
    })
    const body = await Bun.zstdCompress(payload)

    const response = await createApp().request(
      "/images/v1/images/generations",
      {
        body,
        headers: {
          authorization: "Bearer local-client-key",
          "content-encoding": "zstd",
          "content-type": "application/json",
        },
        method: "POST",
      },
    )

    expect(response.status).toBe(200)
    expect(capturedHeaders.get("content-encoding")).toBeNull()
    expect(new TextDecoder().decode(capturedBody)).toBe(payload)
  })

  test("preserves upstream image API errors", async () => {
    upstreamResponse = Response.json(
      {
        error: {
          code: "invalid_size",
          message: "Unsupported image size",
          type: "invalid_request_error",
        },
      },
      {
        headers: {
          "retry-after": "5",
          "x-request-id": "failed-request-id",
        },
        status: 400,
      },
    )

    const response = await createApp().request(
      "/images/v1/images/generations",
      {
        body: JSON.stringify({ model: "gpt-image-2", prompt: "test" }),
        headers: {
          "content-type": "application/json",
          "x-api-key": "local-client-key",
        },
        method: "POST",
      },
    )

    expect(response.status).toBe(400)
    expect(response.headers.get("retry-after")).toBe("5")
    expect(response.headers.get("x-request-id")).toBe("failed-request-id")
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_size",
        message: "Unsupported image size",
        type: "invalid_request_error",
      },
    })
  })

  test("returns a generic error when the image provider is unreachable", async () => {
    upstreamError = new Error(
      "connect ECONNREFUSED https://internal-provider.example",
    )

    const response = await createApp().request(
      "/images/v1/images/generations",
      {
        body: JSON.stringify({ model: "gpt-image-2", prompt: "test" }),
        headers: {
          authorization: "Bearer local-client-key",
          "content-type": "application/json",
        },
        method: "POST",
      },
    )

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: {
        message: "Failed to reach the image provider",
        type: "api_error",
      },
    })
  })

  test("rejects providers that are unavailable or use built-in OAuth", async () => {
    providerConfig = null
    const missingResponse = await createApp().request(
      "/missing/v1/images/generations",
      {
        body: "{}",
        headers: {
          authorization: "Bearer local-client-key",
          "content-type": "application/json",
        },
        method: "POST",
      },
    )

    expect(missingResponse.status).toBe(404)
    expect(await missingResponse.json()).toEqual({
      error: {
        message: "Provider 'missing' not found or disabled",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()

    providerConfig = createProviderConfig({
      authType: "oauth2",
      name: "codex",
      type: "openai-responses",
    })
    const unsupportedResponse = await createApp().request(
      "/codex/v1/images/generations",
      {
        body: "{}",
        headers: {
          authorization: "Bearer local-client-key",
          "content-type": "application/json",
        },
        method: "POST",
      },
    )

    expect(unsupportedResponse.status).toBe(400)
    expect(await unsupportedResponse.json()).toEqual({
      error: {
        message: "Provider 'codex' does not enable /v1/images/generations",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("allows only the image endpoints enabled by provider config", async () => {
    const requestEndpoint = async (
      endpoint: "edits" | "generations",
    ): Promise<Response> =>
      await createApp().request(`/images/v1/images/${endpoint}`, {
        body: "{}",
        headers: {
          authorization: "Bearer local-client-key",
          "content-type": "application/json",
        },
        method: "POST",
      })

    providerConfig = createProviderConfig({
      imageEndpoints: ["generations"],
    })
    expect((await requestEndpoint("generations")).status).toBe(200)
    const disabledEditResponse = await requestEndpoint("edits")
    expect(disabledEditResponse.status).toBe(400)
    expect(await disabledEditResponse.json()).toEqual({
      error: {
        message: "Provider 'images' does not enable /v1/images/edits",
        type: "invalid_request_error",
      },
    })

    providerConfig = createProviderConfig({ imageEndpoints: ["edits"] })
    expect((await requestEndpoint("generations")).status).toBe(400)
    expect((await requestEndpoint("edits")).status).toBe(200)

    providerConfig = createProviderConfig({ imageEndpoints: [] })
    expect((await requestEndpoint("generations")).status).toBe(400)
    expect((await requestEndpoint("edits")).status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("leaves request media-type validation to the image provider", async () => {
    const generationResponse = await createApp().request(
      "/images/v1/images/generations",
      {
        body: "provider-specific-generation-body",
        headers: {
          authorization: "Bearer local-client-key",
          "content-type": "text/plain",
        },
        method: "POST",
      },
    )

    expect(generationResponse.status).toBe(200)
    expect(capturedHeaders.get("content-type")).toBe("text/plain")
    expect(new TextDecoder().decode(capturedBody)).toBe(
      "provider-specific-generation-body",
    )

    const editResponse = await createApp().request("/images/v1/images/edits", {
      body: '{"image":"provider-specific-reference"}',
      headers: {
        authorization: "Bearer local-client-key",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(editResponse.status).toBe(200)
    expect(capturedHeaders.get("content-type")).toBe("application/json")
    expect(new TextDecoder().decode(capturedBody)).toBe(
      '{"image":"provider-specific-reference"}',
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("allows image requests when regular API authentication is disabled", async () => {
    localApiKeys = []

    const response = await createApp().request(
      "/images/v1/images/generations",
      {
        body: JSON.stringify({ model: "gpt-image-2", prompt: "test" }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      },
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("requires valid credentials when regular API authentication is enabled", async () => {
    const missingResponse = await createApp().request(
      "/images/v1/images/generations",
      {
        body: new Uint8Array([1, 2, 3]),
        headers: {
          "content-encoding": "zstd",
          "content-type": "application/json",
        },
        method: "POST",
      },
    )
    const invalidResponse = await createApp().request(
      "/images/v1/images/generations",
      {
        body: "{}",
        headers: {
          authorization: "Bearer wrong-key",
          "content-type": "application/json",
        },
        method: "POST",
      },
    )

    expect(missingResponse.status).toBe(401)
    expect(invalidResponse.status).toBe(401)
    expect(missingResponse.headers.get("www-authenticate")).toBe(
      'Bearer realm="copilot-api"',
    )
    expect(await missingResponse.json()).toEqual({
      error: {
        message: "Unauthorized",
        type: "authentication_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("allows CORS preflight without contacting the image provider", async () => {
    localApiKeys = []

    const response = await createApp().request(
      "/images/v1/images/generations",
      {
        headers: {
          "access-control-request-headers": "authorization,content-type",
          "access-control-request-method": "POST",
          origin: "https://client.example",
        },
        method: "OPTIONS",
      },
    )

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
