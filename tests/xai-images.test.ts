import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { invalidateConfigCache } from "~/lib/config-store"
import { PATHS } from "~/lib/paths"
import {
  getImageEditModel,
  getImageGenerationModel,
  resolveConfiguredXaiImageModel,
} from "~/lib/xai-image-model"
import {
  ensureImageResponseB64Json,
  translateXaiImageEditJson,
  translateXaiImageGeneration,
  XaiImagesRequestError,
} from "~/services/xai/images"

const originalConfigPath = PATHS.CONFIG_PATH
const tempDirs: Array<string> = []
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

afterEach(() => {
  PATHS.CONFIG_PATH = originalConfigPath
  invalidateConfigCache()
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function writeConfig(config: Record<string, unknown>): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xai-images-config-"))
  tempDirs.push(tempDir)
  PATHS.CONFIG_PATH = path.join(tempDir, "config.json")
  fs.writeFileSync(PATHS.CONFIG_PATH, JSON.stringify(config))
  invalidateConfigCache()
}

describe("xAI image model config", () => {
  test("keeps empty settings on the OpenAI path", () => {
    expect(
      resolveConfiguredXaiImageModel(undefined, "imageGenerationModel"),
    ).toEqual({
      status: "disabled",
    })
    expect(resolveConfiguredXaiImageModel(null, "imageEditModel")).toEqual({
      status: "disabled",
    })
    expect(resolveConfiguredXaiImageModel("  ", "imageEditModel")).toEqual({
      status: "disabled",
    })
  })

  test("accepts an xai model alias and rejects other providers", () => {
    expect(
      resolveConfiguredXaiImageModel(
        "  XAI/grok-imagine-image-2.0  ",
        "imageGenerationModel",
      ),
    ).toEqual({ model: "grok-imagine-image-2.0", status: "xai" })
    expect(
      resolveConfiguredXaiImageModel("openrouter/image", "imageEditModel"),
    ).toEqual({
      message:
        "imageEditModel only supports an xai/model alias, received 'openrouter/image'",
      status: "invalid",
    })
    expect(resolveConfiguredXaiImageModel(1, "imageGenerationModel")).toEqual({
      message: "imageGenerationModel must be an xai/model alias",
      status: "invalid",
    })
  })

  test("reads generation and edit settings independently", () => {
    writeConfig({
      imageEditModel: "",
      imageGenerationModel: "xai/grok-imagine-image",
    })

    expect(getImageGenerationModel()).toEqual({
      model: "grok-imagine-image",
      status: "xai",
    })
    expect(getImageEditModel()).toEqual({ status: "disabled" })
  })
})

describe("xAI image request translation", () => {
  test.each(["grok-imagine-image", "grok-imagine-image-pro"])(
    "omits unsupported quality for %s in generations and edits",
    (model) => {
      expect(
        translateXaiImageGeneration({ prompt: "ok", quality: "hd" }, model)
          .quality,
      ).toBeUndefined()
      expect(
        translateXaiImageEditJson(
          { image: "https://example.com/a.png", prompt: "ok", quality: "high" },
          model,
        ).quality,
      ).toBeUndefined()
    },
  )

  test("maps an OpenAI generation body onto the configured model", () => {
    expect(
      translateXaiImageGeneration(
        {
          background: "transparent",
          model: "gpt-image-1",
          n: 2,
          prompt: "a red apple",
          quality: "HIGH",
          response_format: "b64_json",
          size: "1792x1024",
        },
        "grok-imagine-image-2.0",
      ),
    ).toEqual({
      aspect_ratio: "16:9",
      model: "grok-imagine-image-2.0",
      n: 2,
      prompt: "a red apple",
      quality: "medium",
      resolution: "2k",
      response_format: "b64_json",
    })
  })

  test("lets an explicit aspect ratio win and derives 1k from a square size", () => {
    expect(
      translateXaiImageGeneration(
        {
          aspect_ratio: "9:16",
          prompt: "portrait",
          resolution: "1k",
          size: "1024x1024",
        },
        "grok-imagine-image",
      ),
    ).toEqual({
      aspect_ratio: "9:16",
      model: "grok-imagine-image",
      prompt: "portrait",
      resolution: "1k",
      response_format: "b64_json",
    })
  })

  test("rejects generation bodies xAI cannot accept", () => {
    expect(() => translateXaiImageGeneration([], "model")).toThrow(
      XaiImagesRequestError,
    )
    expect(() => translateXaiImageGeneration({ prompt: " " }, "model")).toThrow(
      "prompt is required",
    )
    expect(() =>
      translateXaiImageGeneration({ n: 11, prompt: "ok" }, "model"),
    ).toThrow("n must be an integer from 1 to 10")
    expect(() =>
      translateXaiImageGeneration({ prompt: "ok", stream: true }, "model"),
    ).toThrow("xAI image requests do not support streaming")
    expect(() =>
      translateXaiImageGeneration(
        { aspect_ratio: "5:4", prompt: "ok" },
        "model",
      ),
    ).toThrow("aspect_ratio must be a supported xAI ratio")
  })

  test("keeps an explicit url response format", () => {
    expect(
      translateXaiImageGeneration(
        { prompt: "ok", response_format: "url" },
        "grok-imagine-image",
      ).response_format,
    ).toBe("url")
  })

  test("sends multiple JSON references and rejects masks or too many images", () => {
    const images = [
      { image_url: "https://example.com/a.png" },
      { image_url: "data:image/jpeg;base64,/9j/AA==" },
    ]
    const payload = translateXaiImageEditJson(
      { prompt: "combine them", images },
      "grok-imagine-image-2.0",
    )
    expect(payload.image).toBeUndefined()
    expect(payload.images).toEqual([
      { type: "image_url", url: "https://example.com/a.png" },
      { type: "image_url", url: "data:image/jpeg;base64,/9j/AA==" },
    ])
    expect(() =>
      translateXaiImageEditJson(
        {
          prompt: "cut it",
          images,
          mask: { image_url: "https://example.com/mask.png" },
        },
        "model",
      ),
    ).toThrow("xAI image edits do not support mask")
    expect(() =>
      translateXaiImageEditJson(
        {
          prompt: "too many",
          images: Array.from({ length: 6 }, (_, index) => ({
            image_url: `https://example.com/${index}.png`,
          })),
        },
        "model",
      ),
    ).toThrow("xAI image edits accept at most 5 images")
  })

  test("translates a JSON edit image", () => {
    expect(
      translateXaiImageEditJson(
        {
          image: { b64_json: png.toString("base64"), mime_type: "image/png" },
          model: "gpt-image-1",
          prompt: "paint it",
        },
        "grok-imagine-image-2.0",
      ).image,
    ).toEqual({
      type: "image_url",
      url: "data:image/png;base64," + png.toString("base64"),
    })
    expect(() =>
      translateXaiImageEditJson({ prompt: "missing image" }, "model"),
    ).toThrow("image is required")
  })

  test("translates OpenAI JSON images[].image_url references used by imagegen", () => {
    const dataUrl = "data:image/png;base64," + png.toString("base64")
    expect(
      translateXaiImageEditJson(
        { images: [{ image_url: dataUrl }], prompt: "make it green" },
        "grok-imagine-image-2.0",
      ).image,
    ).toEqual({ type: "image_url", url: dataUrl })
    expect(
      translateXaiImageEditJson(
        {
          images: [
            { image_url: dataUrl },
            { image_url: "https://example.com/a.png" },
          ],
          prompt: "combine them",
        },
        "grok-imagine-image-2.0",
      ).images,
    ).toEqual([
      { type: "image_url", url: dataUrl },
      { type: "image_url", url: "https://example.com/a.png" },
    ])
    expect(() =>
      translateXaiImageEditJson(
        { images: [{ file_id: "file-test" }], prompt: "ok" },
        "model",
      ),
    ).toThrow("file_id is not supported")
  })

  test("embeds b64_json when xAI returns only a URL", async () => {
    const response = await ensureImageResponseB64Json(
      new Response(
        JSON.stringify({
          data: [{ mime_type: "image/png", url: "https://imgen.x.ai/fox.png" }],
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
      () =>
        Promise.resolve(
          new Response(Uint8Array.from([1, 2, 3]), {
            headers: { "content-type": "image/png" },
            status: 200,
          }),
        ),
    )

    const body = await readJsonObject(response)
    expect(body.data).toEqual([
      {
        b64_json: Buffer.from([1, 2, 3]).toString("base64"),
        mime_type: "image/png",
        url: "https://imgen.x.ai/fox.png",
      },
    ])
    expectUnixCreated(body.created)
  })

  test("replaces a null generation created timestamp", async () => {
    let fetched = false
    const response = await ensureImageResponseB64Json(
      new Response(
        JSON.stringify({
          background: null,
          created: null,
          data: [{ b64_json: "abc", revised_prompt: "", url: null }],
        }),
        { status: 200 },
      ),
      () => {
        fetched = true
        return Promise.resolve(new Response(null, { status: 500 }))
      },
    )

    const body = await readJsonObject(response)
    expect(fetched).toBe(false)
    expect(body.data).toEqual([
      { b64_json: "abc", revised_prompt: "", url: null },
    ])
    expect(body.background).toBeNull()
    expectUnixCreated(body.created)
  })

  test("adds created when an edit response omits it", async () => {
    const response = await ensureImageResponseB64Json(
      new Response(
        JSON.stringify({
          data: [
            {
              mime_type: "image/jpeg",
              revised_prompt: "",
              url: "https://imgen.x.ai/edit.jpeg",
            },
          ],
          usage: { cost_in_usd_ticks: 220000000 },
        }),
        { status: 200 },
      ),
      () =>
        Promise.resolve(
          new Response(Uint8Array.from([9]), {
            status: 200,
          }),
        ),
    )

    const body = await readJsonObject(response)
    const images = body.data
    const image: unknown = Array.isArray(images) ? images[0] : undefined
    expect(isRecord(image) ? image.b64_json : undefined).toBe(
      Buffer.from([9]).toString("base64"),
    )
    expect(body.usage).toEqual({ cost_in_usd_ticks: 220000000 })
    expectUnixCreated(body.created)
  })

  test("keeps a numeric created timestamp", async () => {
    const response = await ensureImageResponseB64Json(
      new Response(
        JSON.stringify({
          created: 1_710_000_000,
          data: [{ b64_json: "abc" }],
        }),
        { status: 200 },
      ),
    )

    expect(await response.json()).toEqual({
      created: 1_710_000_000,
      data: [{ b64_json: "abc" }],
    })
  })
})

describe("xAI image response normalization", () => {
  function urlResponse(url = "https://imgen.x.ai/output.png"): Response {
    return Response.json({ created: null, data: [{ url }] })
  }

  test("reports output URLs for logging even when URL output skips downloading", async () => {
    const urls: Array<string> = []
    const response = await ensureImageResponseB64Json(
      urlResponse(),
      undefined,
      {
        responseFormat: "url",
        onImageUrl: (url) => {
          urls.push(url)
        },
      },
    )
    expect(response.status).toBe(200)
    expect(urls).toEqual(["https://imgen.x.ai/output.png"])
  })

  test("reports a URL before a failed fallback and omits URL credentials from logs", async () => {
    const urls: Array<string> = []
    const response = await ensureImageResponseB64Json(
      urlResponse(
        "https://user:password@imgen.x.ai/output.png?token=secret&format=png",
      ),
      undefined,
      {
        onImageUrl: (url) => {
          urls.push(url)
        },
      },
    )
    expect(response.status).toBe(502)
    expect(urls).toEqual([
      "https://imgen.x.ai/output.png?token=%5BREDACTED%5D&format=png",
    ])
  })

  test("returns requested URLs without downloading while normalizing created", async () => {
    let fetched = false
    const response = await ensureImageResponseB64Json(
      urlResponse(),
      () => {
        fetched = true
        return Promise.resolve(new Response(png))
      },
      { responseFormat: "url" },
    )
    expect(fetched).toBe(false)
    const payload = await readJsonObject(response)
    expect(payload.data).toEqual([{ url: "https://imgen.x.ai/output.png" }])
    expectUnixCreated(payload.created)
  })

  test.each([
    "https://127.0.0.1/private",
    "https://[::1]/private",
    "https://localhost/private",
    "https://10.0.0.1/private",
    "https://imgen.x.ai.attacker.example/image.png",
    "https://imgen.x.ai:8443/image.png",
    "https://user:password@imgen.x.ai/image.png",
    "http://imgen.x.ai/image.png",
    "not-a-url",
  ])("refuses to fetch an untrusted output URL: %s", async (url) => {
    let fetched = false
    const response = await ensureImageResponseB64Json(urlResponse(url), () => {
      fetched = true
      return Promise.resolve(new Response(png))
    })
    expect(fetched).toBe(false)
    expect(response.status).toBe(502)
  })

  test("disables redirects when downloading and reports redirect failure", async () => {
    let redirectMode: RequestInit["redirect"]
    const response = await ensureImageResponseB64Json(
      urlResponse(),
      (_url, init) => {
        redirectMode = init.redirect
        return Promise.resolve(
          new Response(null, {
            headers: { location: "https://127.0.0.1/private" },
            status: 302,
          }),
        )
      },
    )
    expect(redirectMode).toBe("error")
    expect(response.status).toBe(502)
  })

  test("stops and cancels an oversized chunked download without a length header", async () => {
    let pulls = 0
    let cancelled = false
    const chunk = new Uint8Array(1024 * 1024)
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1
          controller.enqueue(chunk)
          if (pulls === 40) controller.close()
        },
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    const response = await ensureImageResponseB64Json(urlResponse(), () =>
      Promise.resolve(new Response(body)),
    )
    expect(response.status).toBe(502)
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(40)
  })

  test("cancels a download rejected by its declared content length", async () => {
    let cancelled = false
    let pulled = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true
          controller.enqueue(png)
          controller.close()
        },
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    const response = await ensureImageResponseB64Json(urlResponse(), () =>
      Promise.resolve(
        new Response(body, {
          headers: { "content-length": String(33 * 1024 * 1024) },
        }),
      ),
    )
    expect(response.status).toBe(502)
    expect(pulled).toBe(false)
    expect(cancelled).toBe(true)
  })

  test("joins image chunks without changing their bytes", async () => {
    const response = await ensureImageResponseB64Json(urlResponse(), () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(png.subarray(0, 10))
              controller.enqueue(png.subarray(10))
              controller.close()
            },
          }),
        ),
      ),
    )
    expect((await readJsonObject(response)).data).toEqual([
      {
        b64_json: png.toString("base64"),
        url: "https://imgen.x.ai/output.png",
      },
    ])
  })

  test.each([404, 500])(
    "reports download HTTP %s as an upstream error and cancels its body",
    async (status) => {
      let cancelled = false
      const response = await ensureImageResponseB64Json(urlResponse(), () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true
              },
            }),
            { status },
          ),
        ),
      )
      expect(response.status).toBe(502)
      expect(cancelled).toBe(true)
    },
  )

  test("reports download network failures and empty images as upstream errors", async () => {
    for (const fetcher of [
      () => Promise.reject(new TypeError("network unavailable")),
      () => Promise.resolve(new Response(null)),
      () => Promise.resolve(new Response(new Uint8Array())),
    ]) {
      const response = await ensureImageResponseB64Json(urlResponse(), fetcher)
      expect(response.status).toBe(502)
      expect((await readJsonObject(response)).error).toEqual({
        message: "Failed to retrieve xAI image output as b64_json",
        type: "upstream_error",
      })
    }
  })

  test("propagates client cancellation to the image download", async () => {
    const controller = new AbortController()
    let downloadSignal: AbortSignal | null | undefined
    const task = ensureImageResponseB64Json(
      urlResponse(),
      (_url, init) => {
        downloadSignal = init.signal
        const reason = new Error("The operation was aborted")
        reason.name = "AbortError"
        controller.abort(reason)
        return Promise.reject(reason)
      },
      { clientSignal: controller.signal },
    )
    await Promise.resolve(expect(task).rejects.toThrow("aborted"))
    expect(downloadSignal?.aborted).toBe(true)
  })

  test("keeps unsuccessful, non-JSON, and non-image upstream responses intact", async () => {
    const error = new Response("quota exceeded", { status: 429 })
    expect(await ensureImageResponseB64Json(error)).toBe(error)
    for (const body of ["not-json", "null", '{"unexpected":true}']) {
      expect(
        await (await ensureImageResponseB64Json(new Response(body))).text(),
      ).toBe(body)
    }
  })
})

function expectUnixCreated(value: unknown): void {
  expect(typeof value).toBe("number")
  expect(Number.isInteger(value)).toBe(true)
  const now = Math.floor(Date.now() / 1000)
  expect(value).toBeGreaterThan(now - 120)
  expect(value).toBeLessThanOrEqual(now + 5)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json()
  if (!isRecord(payload)) throw new Error("expected a JSON object")
  return payload
}
