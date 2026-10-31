import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import type { ResolvedProviderConfig } from "~/lib/config"
import { DEFAULT_IMAGE_MODELS } from "~/lib/image-models"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { invalidateConfigCache } from "~/lib/config-store"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"
import { closeUsageStore, getTokenUsageEventsPage } from "~/lib/token-usage"
import { traceIdMiddleware } from "~/lib/trace"
import { imageRouteDependencies, imageRoutes } from "~/routes/images/route"
import { providerImageRoutes } from "~/routes/provider/images/route"
import {
  DEFAULT_COPILOT_IMAGE_MODEL,
  resolveCopilotImagesUrl,
} from "~/services/copilot/images"

const model = DEFAULT_COPILOT_IMAGE_MODEL
const alias = `github-copilot/${model}`
const originalFetch = globalThis.fetch
const originalState = {
  ...state,
  githubToken: state.githubToken,
  copilotToken: state.copilotToken,
  copilotApiUrl: state.copilotApiUrl,
  codexAccessToken: state.codexAccessToken,
  codexAccountId: state.codexAccountId,
}
const originalConfigPath = PATHS.CONFIG_PATH
const originalDependencies = { ...imageRouteDependencies }
const environmentKeys = [
  "COPILOT_API_ENTERPRISE_URL",
  "COPILOT_API_OAUTH_APP",
  "COPILOT_API_SQLITE_DB_PATH",
] as const
const originalEnvironment = environmentKeys.map(
  (key) => [key, process.env[key]] as const,
)
let directory: string
let forwardedPayload: unknown
const fetchMock = mock(
  async (_url: string | URL | Request, init?: RequestInit) => {
    forwardedPayload = await new Response(init?.body).json()
    return Response.json({ created: 123, data: [{ b64_json: "generated" }] })
  },
)

function configure(enabled: boolean) {
  writeFileSync(
    PATHS.CONFIG_PATH,
    JSON.stringify({ providers: { "github-copilot": { enabled } } }),
  )
  invalidateConfigCache()
}

function app() {
  return new Hono()
    .use(traceIdMiddleware)
    .route("/images", imageRoutes)
    .route("/v1/images", imageRoutes)
    .route("/:provider/images", providerImageRoutes)
    .route("/:provider/v1/images", providerImageRoutes)
}

function post(path: string, payload: Record<string, unknown>) {
  return app().request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "copilot-images-"))
  PATHS.CONFIG_PATH = join(directory, "config.json")
  for (const key of environmentKeys) Reflect.deleteProperty(process.env, key)
  process.env.COPILOT_API_SQLITE_DB_PATH = ":memory:"
  Object.assign(state, {
    githubToken: "github-image-token",
    copilotToken: "different-chat-token",
    accountType: "individual",
    copilotApiUrl: undefined,
    verbose: false,
  })
  configure(true)
  forwardedPayload = undefined
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (_url, init) => {
    forwardedPayload = await new Response(init?.body).json()
    return Response.json({ created: 123, data: [{ b64_json: "generated" }] })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  imageRouteDependencies.resolveMappedModel = (value) => value
  imageRouteDependencies.resolveProviderConfig = () => Promise.resolve(null)
  imageRouteDependencies.isGitHubCopilotAvailable = () => true
  imageRouteDependencies.getImageEditModel = () => ({ status: "disabled" })
  imageRouteDependencies.getImageGenerationModel = () => ({
    status: "disabled",
  })
})

afterEach(async () => {
  await closeUsageStore()
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  Object.assign(imageRouteDependencies, originalDependencies)
  PATHS.CONFIG_PATH = originalConfigPath
  invalidateConfigCache()
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  rmSync(directory, { recursive: true, force: true })
})

describe("Copilot images routing", () => {
  for (const operation of ["generations", "edits"] as const) {
    test.each(["/images", "/v1/images"])(
      `forwards ${operation} through the Copilot model alias at %s`,
      async (prefix) => {
        const payload = {
          model: alias,
          prompt: "a red apple",
          size: "1024x1024",
          n: 2,
          output_format: "png",
          stream: false,
          response_format: "b64_json",
          ...(operation === "edits" && {
            images: [{ image_url: "data:image/png;base64,YXBwbGU=" }],
            mask: { image_url: "https://example.test/mask.png" },
          }),
        }
        const response = await app().request(`${prefix}/${operation}?test=1`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer gateway-key",
            "user-agent": "caller-agent",
            "x-client-machine-id": "caller-machine",
            "copilot-integration-id": "caller-integration",
          },
          body: JSON.stringify(payload),
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          created: 123,
          data: [{ b64_json: "generated" }],
        })
        expect(forwardedPayload).toEqual({ ...payload, model })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe(
          `https://api.individual.githubcopilot.com/v1/images/${operation}?test=1`,
        )
        const headers = new Headers(init?.headers)
        expect(Object.fromEntries(headers)).toMatchObject({
          authorization: "Bearer github-image-token",
          "content-type": "application/json",
          accept: "application/json",
          "copilot-integration-id": "vscode-chat",
          "copilot-harness-id": "copilot-sdk",
          "editor-version": "copilot/1.0.103-unstable.r40031404408.gba6c003",
          "openai-intent": "conversation-agent",
          "x-initiator": "agent",
          "x-github-api-version": "2026-08-01",
          "x-client-machine-id": state.vsCodeDeviceId,
        })
        expect(headers.get("user-agent")).toContain("client/vscode-agent-host")
        expect(headers.get("x-interaction-id")).toMatch(
          /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u,
        )
        expect(headers.has("content-length")).toBe(false)
        expect(init?.body).toBeInstanceOf(ReadableStream)
        expect(init?.signal).toBeInstanceOf(AbortSignal)
      },
    )

    test(`honors model mappings for ${operation}`, async () => {
      imageRouteDependencies.resolveMappedModel = () => alias
      const response = await post(`/v1/images/${operation}`, {
        model: "my-image",
        prompt: "mapped",
        images: [{ file_id: "file-image" }],
      })
      expect(response.status).toBe(200)
      expect(forwardedPayload).toMatchObject({ model, prompt: "mapped" })
      await response.text()
    })

    test.each(["/github-copilot/images", "/github-copilot/v1/images"])(
      `supports provider-scoped ${operation} at %s`,
      async (prefix) => {
        const response = await post(`${prefix}/${operation}`, {
          model,
          prompt: "scoped",
        })
        expect(response.status).toBe(200)
        expect(forwardedPayload).toEqual({ model, prompt: "scoped" })
        await response.text()
      },
    )

    test.each(["disabled", "missing-token"])(
      `rejects scoped ${operation} when Copilot is %s without falling back`,
      async (reason) => {
        if (reason === "disabled") configure(false)
        else state.githubToken = undefined
        const response = await post(`/github-copilot/v1/images/${operation}`, {
          model: alias,
          prompt: "blocked",
        })
        expect(response.status).toBe(reason === "disabled" ? 403 : 401)
        expect(await response.json()).toHaveProperty("error")
        expect(fetchMock).not.toHaveBeenCalled()
      },
    )

    test.each(["future-image", "github-copilot/future-image", "gpt-image-2"])(
      `preserves scoped Copilot ${operation} model %s without checking other providers`,
      async (requested) => {
        const resolve = mock(imageRouteDependencies.resolveProviderConfig)
        imageRouteDependencies.resolveProviderConfig = resolve
        const response = await post(`/github-copilot/v1/images/${operation}`, {
          model: requested,
          prompt: "future image",
        })
        expect(response.status).toBe(200)
        expect(forwardedPayload).toHaveProperty(
          "model",
          requested === "github-copilot/future-image" ? "future-image" : (
            requested
          ),
        )
        expect(resolve).not.toHaveBeenCalled()
        await response.text()
      },
    )
  }

  test("supplies JSON content type when generations omit it", async () => {
    const response = await app().request("/v1/images/generations", {
      method: "POST",
      body: new TextEncoder().encode(
        JSON.stringify({ model: alias, prompt: "cat" }),
      ),
    })
    expect(response.status).toBe(200)
    expect(
      new Headers(fetchMock.mock.calls[0][1]?.headers).get("content-type"),
    ).toBe("application/json")
    await response.text()
  })

  test("preserves large edit images when the model comes after image data", async () => {
    const images = [
      { image_url: `data:image/png;base64,${"A".repeat(100_000)}` },
    ]
    const response = await post("/v1/images/edits", {
      images,
      model: alias,
      prompt: "edit",
    })
    expect(response.status).toBe(200)
    expect(forwardedPayload).toEqual({ images, model, prompt: "edit" })
    await response.text()
  })

  test.each(["/v1/images/edits", "/github-copilot/v1/images/edits"])(
    "converts multipart images and masks to OpenAI JSON at %s",
    async (path) => {
      const form = new FormData()
      form.set("model", path.startsWith("/v1/") ? alias : model)
      form.set("prompt", "edit apple")
      form.append(
        "image",
        new File(["apple"], "apple.png", { type: "image/png" }),
      )
      form.append("image[]", "https://example.test/reference.jpg")
      form.set("mask", new File(["mask"], "mask.png", { type: "image/png" }))
      form.set("n", "2")
      form.set("stream", "false")
      const response = await app().request(path, { method: "POST", body: form })
      expect(response.status).toBe(200)
      expect(forwardedPayload).toEqual({
        model,
        prompt: "edit apple",
        images: [
          { image_url: "data:image/png;base64,YXBwbGU=" },
          { image_url: "https://example.test/reference.jpg" },
        ],
        mask: { image_url: "data:image/png;base64,bWFzaw==" },
        n: 2,
        stream: false,
      })
      await response.text()
    },
  )

  test("rejects unsupported provider-scoped edit content types", async () => {
    const response = await app().request("/github-copilot/v1/images/edits", {
      method: "POST",
      body: "invalid",
    })
    expect(response.status).toBe(415)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("preserves upstream errors and retry metadata", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":{"message":"limited"}}', {
        status: 429,
        headers: {
          "content-type": "application/json",
          "content-length": "999",
          "content-encoding": "gzip",
          "retry-after": "60",
          "x-request-id": "upstream-id",
        },
      }),
    )
    const response = await post("/v1/images/generations", {
      model: alias,
      prompt: "cat",
    })
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("60")
    expect(response.headers.get("x-request-id")).toBe("upstream-id")
    expect(response.headers.has("content-length")).toBe(false)
    expect(response.headers.has("content-encoding")).toBe(false)
    expect(await response.json()).toEqual({ error: { message: "limited" } })
  })

  test("forwards SSE image events without changing their bytes", async () => {
    const sse =
      'event: image_generation.completed\ndata: {"b64_json":"image"}\n\ndata: [DONE]\n\n'
    fetchMock.mockResolvedValueOnce(
      new Response(sse, {
        headers: { "content-type": "text/event-stream" },
      }),
    )
    const response = await post("/v1/images/generations", {
      model: alias,
      stream: true,
    })
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(await response.text()).toBe(sse)
  })

  test("cancels upstream image streams when the client stops reading", async () => {
    const cancel = mock(() => {})
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: image\n\n"))
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    const response = await post("/v1/images/generations", {
      model: alias,
      stream: true,
    })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel("client stopped")
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  test("propagates the client abort signal to the image upstream", async () => {
    const controller = new AbortController()
    let signal: AbortSignal | undefined
    fetchMock.mockImplementationOnce((_url, init) => {
      signal = init?.signal ?? undefined
      controller.abort()
      return Promise.reject(
        Object.assign(new Error("Aborted"), { name: "AbortError" }),
      )
    })
    const response = await app().fetch(
      new Request("http://localhost/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: alias, prompt: "cat" }),
        signal: controller.signal,
      }),
    )
    expect(response.status).toBe(499)
    expect(signal?.aborted).toBe(true)
  })

  test.each(["generations", "edits"])(
    "records %s usage under the Copilot model",
    async (operation) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          data: [{ b64_json: "image" }],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
          copilot_usage: {
            total_nano_aiu: 510_500_000,
            token_details: [
              { token_type: "input", token_count: 73 },
              { token_type: "image_output", token_count: 158 },
            ],
          },
        }),
      )
      const response = await post(`/v1/images/${operation}`, {
        model: alias,
        prompt: "cat",
      })
      await response.text()
      const events = await getTokenUsageEventsPage({
        page: 1,
        pageSize: 20,
        period: "today",
      })
      expect(events.items).toHaveLength(1)
      expect(events.items[0]).toMatchObject({
        source: "copilot",
        provider_name: "github-copilot",
        model,
        endpoint: `images_${operation}`,
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        total_nano_aiu: 510_500_000,
        cost: { amount: 0.005105, currency: "USD", source: "copilot_aiu" },
      })
    },
  )
})

describe("default image provider routing", () => {
  const providers = ["codex", "github-copilot", "xai"] as const
  const configurations: Record<string, ResolvedProviderConfig> = {
    codex: {
      name: "codex",
      type: "openai-responses",
      apiKey: "codex-test-key",
      authType: "oauth2",
      baseUrl: "https://chatgpt.com/backend-api",
    },
    xai: {
      name: "xai",
      type: "openai-responses",
      apiKey: "xai-test-key",
      authType: "authorization",
      baseUrl: "https://api.x.ai",
    },
  }
  for (const [index, provider] of providers.entries()) {
    for (const input of ["missing", "generic"] as const) {
      test.each(["generations", "edits", "multipart"])(
        `defaults ${input} models to ${provider} for %s`,
        async (format) => {
          const available = providers.slice(index)
          const targetModel = DEFAULT_IMAGE_MODELS[provider]
          state.codexAccessToken = "codex-test-token"
          state.codexAccountId = "codex-test-account"
          imageRouteDependencies.isGitHubCopilotAvailable = () =>
            available.includes("github-copilot")
          imageRouteDependencies.resolveProviderConfig = (name) =>
            Promise.resolve(
              available.some((provider) => provider === name) ?
                (configurations[name] ?? null)
              : null,
            )
          const operation = format === "generations" ? "generations" : "edits"
          fetchMock.mockImplementationOnce(async (_url, init) => {
            forwardedPayload = await new Response(init?.body).json()
            return Response.json({
              data: [{ b64_json: "image" }],
              usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
              ...(provider === "github-copilot" ?
                { copilot_usage: { total_nano_aiu: 510_500_000 } }
              : {}),
            })
          })
          const form = new FormData()
          form.set("prompt", "a cat")
          form.set(
            "image",
            new File(["image"], "image.png", { type: "image/png" }),
          )
          if (input === "generic") form.set("model", "gpt-image-2")
          const response = await app().request(`/v1/images/${operation}`, {
            method: "POST",
            headers:
              format === "multipart" ?
                {}
              : { "content-type": "application/json" },
            body:
              format === "multipart" ? form : (
                JSON.stringify({
                  ...(input === "generic" ? { model: "gpt-image-2" } : {}),
                  prompt: "a cat",
                  ...(operation === "edits" ?
                    {
                      images: [{ image_url: "data:image/png;base64,aW1hZ2U=" }],
                    }
                  : {}),
                })
              ),
          })
          expect(response.status).toBe(200)
          await response.text()
          expect(forwardedPayload).toHaveProperty("model", targetModel)
          const expectedUrl =
            provider === "codex" ?
              `https://chatgpt.com/backend-api/codex/images/${operation}`
            : provider === "xai" ? `https://api.x.ai/v1/images/${operation}`
            : `https://api.individual.githubcopilot.com/v1/images/${operation}`
          expect(fetchMock.mock.calls[0][0]).toBe(expectedUrl)
          const events = await getTokenUsageEventsPage({
            page: 1,
            pageSize: 10,
            period: "today",
          })
          expect(events.items[0]).toMatchObject({
            provider_name: provider,
            model: targetModel,
            input_tokens: 10,
            output_tokens: 20,
            total_tokens: 30,
          })
        },
      )
    }
  }

  test.each(["generations", "edits"])(
    "fills the scoped Copilot %s model and records it",
    async (operation) => {
      fetchMock.mockImplementationOnce(async (_url, init) => {
        forwardedPayload = await new Response(init?.body).json()
        return Response.json({
          data: [],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        })
      })
      const response = await post(`/github-copilot/v1/images/${operation}`, {
        prompt: "cat",
      })
      expect(response.status).toBe(200)
      await response.text()
      expect(forwardedPayload).toHaveProperty("model", model)
      expect(
        (
          await getTokenUsageEventsPage({
            page: 1,
            pageSize: 10,
            period: "today",
          })
        ).items[0],
      ).toMatchObject({ model, provider_name: "github-copilot" })
    },
  )

  test("returns 404 without dispatching when all default providers are unavailable", async () => {
    imageRouteDependencies.isGitHubCopilotAvailable = () => false
    const response = await post("/v1/images/generations", { prompt: "cat" })
    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("Copilot images upstream selection", () => {
  test.each(["individual", "business", "enterprise"])(
    "uses the %s account host",
    (accountType) => {
      state.accountType = accountType
      expect(
        resolveCopilotImagesUrl(
          "http://localhost/v1/images/edits?a=1",
          "edits",
        ),
      ).toBe(`https://api.${accountType}.githubcopilot.com/v1/images/edits?a=1`)
    },
  )

  test("uses the API URL supplied by the Copilot session", () => {
    state.copilotApiUrl = "https://copilot.example.test"
    expect(
      resolveCopilotImagesUrl(
        "http://localhost/images/generations",
        "generations",
      ),
    ).toBe("https://copilot.example.test/v1/images/generations")
  })

  test("honors the enterprise domain", () => {
    process.env.COPILOT_API_ENTERPRISE_URL = "https://github.enterprise.test"
    expect(
      resolveCopilotImagesUrl("http://localhost/images/edits", "edits"),
    ).toBe("https://copilot-api.github.enterprise.test/v1/images/edits")
  })

  test("uses SDK image headers even when the configured OAuth app is OpenCode", async () => {
    process.env.COPILOT_API_OAUTH_APP = "opencode"
    const response = await post("/v1/images/generations", {
      model: alias,
      prompt: "cat",
    })
    expect(response.status).toBe(200)
    expect(
      new Headers(fetchMock.mock.calls[0][1]?.headers).get(
        "copilot-harness-id",
      ),
    ).toBe("copilot-sdk")
    await response.text()
  })
})
