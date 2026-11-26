import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildAugmentedPrompt,
  buildDefaultBatchOutputDir,
  buildDefaultOutputPath,
  buildEndpointUrl,
  buildOutputPaths,
  CliError,
  DEFAULT_OUTPUT_SUBDIR,
  detectImageMime,
  isLoopbackUrl,
  normalizeBaseUrl,
  normalizeOutputFormat,
  resolveDefaultOutputDir,
  runImageGen,
  validateGptImage2Size,
  validateImageOptions,
} from "../.agents/skills/copilot-api-imagegen/scripts/image_gen.mjs"
import { parseMultipartImageEdit } from "~/routes/images/multipart-edits"

const PNG_BYTES = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
])
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP"),
])
const GIF_BYTES = Buffer.from("GIF89a\x01\x00\x01\x00")

let tempDir: string

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString()
}

async function expectReject(
  promise: Promise<unknown>,
  expected: RegExp | typeof CliError,
): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  if (expected instanceof RegExp) {
    expect((caught as Error).message).toMatch(expected)
  } else {
    expect(caught).toBeInstanceOf(expected)
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-skill-imagegen-"))
})

afterEach(async () => {
  await fs.promises.rm(tempDir, { recursive: true, force: true })
})

describe("copilot-api-imagegen helpers", () => {
  test("normalizes URLs, endpoints, output formats, and detects MIME types", () => {
    expect(normalizeBaseUrl(undefined)).toBe("http://localhost:4141")
    expect(normalizeBaseUrl("http://localhost:4141/v1/")).toBe(
      "http://localhost:4141",
    )
    expect(() => normalizeBaseUrl("ftp://localhost:4141")).toThrow(CliError)
    expect(() => normalizeBaseUrl("http://u:p@localhost:4141")).toThrow(
      CliError,
    )
    expect(() => normalizeBaseUrl("not-a-url")).toThrow(CliError)
    expect(isLoopbackUrl("http://127.0.0.1:4141")).toBe(true)
    expect(isLoopbackUrl("https://api.example.com")).toBe(false)

    expect(
      buildEndpointUrl("http://localhost:4141", "generations", undefined),
    ).toBe("http://localhost:4141/v1/images/generations")
    expect(buildEndpointUrl("http://localhost:4141", "edits", "xai")).toBe(
      "http://localhost:4141/xai/v1/images/edits",
    )

    expect(normalizeOutputFormat(undefined)).toBe("png")
    expect(normalizeOutputFormat("jpg")).toBe("jpeg")
    expect(normalizeOutputFormat("gif")).toBe("gif")
    expect(() => normalizeOutputFormat("bmp")).toThrow(CliError)

    expect(detectImageMime(PNG_BYTES)).toBe("image/png")
    expect(detectImageMime(JPEG_BYTES)).toBe("image/jpeg")
    expect(detectImageMime(WEBP_BYTES)).toBe("image/webp")
    expect(detectImageMime(GIF_BYTES)).toBe("image/gif")
    expect(detectImageMime(Buffer.from("plain"), "fallback.png")).toBe(
      "image/png",
    )
    expect(detectImageMime(Buffer.from("plain"), "fallback.jpg")).toBe(
      "image/jpeg",
    )
    expect(detectImageMime(Buffer.from("plain"), "fallback.webp")).toBe(
      "image/webp",
    )
    expect(detectImageMime(Buffer.from("plain"), "fallback.gif")).toBe(
      "image/gif",
    )
    expect(() => detectImageMime(Buffer.from("plain"), "file.bin")).toThrow(
      CliError,
    )
  })

  test("validates gpt-image-2 sizes and provider/model constraints", () => {
    expect(() => validateGptImage2Size("auto")).not.toThrow()
    expect(() => validateGptImage2Size("1024x1024")).not.toThrow()
    expect(() => validateGptImage2Size("2048x1152")).not.toThrow()
    expect(() => validateGptImage2Size("3840x2160")).not.toThrow()

    expect(() => validateGptImage2Size("wide")).toThrow(CliError)
    expect(() => validateGptImage2Size("1000x1000")).toThrow(/multiples of 16/u)
    expect(() => validateGptImage2Size("4096x2048")).toThrow(/<= 3840/u)
    expect(() => validateGptImage2Size("3200x800")).toThrow(/3:1/u)
    expect(() => validateGptImage2Size("512x512")).toThrow(/total pixels/u)

    const base = {
      operation: "generations" as const,
      model: "gpt-image-2",
      provider: undefined,
      size: "auto",
      quality: "medium",
      background: undefined,
      outputFormat: "png",
      outputCompression: undefined,
      inputFidelity: undefined,
      moderation: undefined,
      frameCount: undefined,
      frameDurationMs: undefined,
      aspectRatio: undefined,
      resolution: undefined,
    }

    expect(() =>
      validateImageOptions({ ...base, background: "transparent" }),
    ).toThrow(/gpt-image-1\.5/u)
    expect(() =>
      validateImageOptions({
        ...base,
        operation: "edits",
        inputFidelity: "high",
        imageCount: 1,
      }),
    ).toThrow(/input_fidelity/u)
    expect(() =>
      validateImageOptions({
        ...base,
        model: "gpt-image-1.5",
        size: "2048x2048",
      }),
    ).toThrow(/1024x1024/u)
    expect(() =>
      validateImageOptions({
        ...base,
        model: "gpt-image-1.5",
        size: "1024x1024",
        background: "transparent",
        outputFormat: "jpeg",
      }),
    ).toThrow(/png or webp/u)
    expect(() =>
      validateImageOptions({
        ...base,
        outputFormat: "png",
        outputCompression: 85,
      }),
    ).toThrow(/jpeg or webp/u)
    expect(() => validateImageOptions({ ...base, frameCount: 10 })).toThrow(
      /--output-format gif/u,
    )
    expect(() =>
      validateImageOptions({
        ...base,
        operation: "edits",
        outputFormat: "gif",
        imageCount: 1,
      }),
    ).toThrow(/only supported for generate/u)
    expect(() =>
      validateImageOptions({
        ...base,
        model: "xai/grok-imagine-image-2.0",
        outputFormat: "gif",
      }),
    ).toThrow(/xAI.*GIF/u)
    expect(() =>
      validateImageOptions({
        ...base,
        model: "github-copilot/gpt-image-2.5-flare",
        outputFormat: "gif",
      }),
    ).toThrow(/Flare.*GIF/u)
    expect(() =>
      validateImageOptions({
        ...base,
        operation: "edits",
        model: "xai/grok-imagine-image-2.0",
        imageCount: 6,
      }),
    ).toThrow(/at most 5/u)
    expect(() =>
      validateImageOptions({
        ...base,
        operation: "edits",
        model: "xai/grok-imagine-image-2.0",
        imageCount: 1,
        hasMask: true,
      }),
    ).toThrow(/--mask/u)
  })

  test("augments prompts only when hints are present and builds output paths", () => {
    expect(buildAugmentedPrompt(true, "A ceramic mug", {})).toBe(
      "A ceramic mug",
    )
    expect(
      buildAugmentedPrompt(true, "A ceramic mug", {
        use_case: "product-mockup",
        lighting: "soft studio",
        constraints: "no watermark",
      }),
    ).toBe(
      [
        "Use case: product-mockup",
        "Primary request: A ceramic mug",
        "Lighting/mood: soft studio",
        "Constraints: no watermark",
      ].join("\n"),
    )
    expect(
      buildAugmentedPrompt(false, "Raw prompt", { lighting: "ignored" }),
    ).toBe("Raw prompt")

    let warn = ""
    expect(
      buildOutputPaths("out/hero", "png", 2, undefined, (msg) => {
        warn += msg
      }),
    ).toEqual([path.join("out", "hero-1.png"), path.join("out", "hero-2.png")])
    expect(
      buildOutputPaths("out/ignored.png", "webp", 2, "custom-dir", () => {}),
    ).toEqual([
      path.join("custom-dir", "image_1.webp"),
      path.join("custom-dir", "image_2.webp"),
    ])
    expect(warn).toBe("")
    expect(
      buildOutputPaths("out/hero.jpg", "png", 1, undefined, (msg) => {
        warn += msg
      }),
    ).toEqual(["out/hero.jpg"])
    expect(warn).toContain("does not match")

    expect(resolveDefaultOutputDir({})).toBe(
      path.join(path.resolve(os.tmpdir()), DEFAULT_OUTPUT_SUBDIR),
    )
    const customTmpEnv = { TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir }
    const expectedDir = path.join(path.resolve(tempDir), DEFAULT_OUTPUT_SUBDIR)
    expect(resolveDefaultOutputDir(customTmpEnv)).toBe(expectedDir)
    const defaultImg1 = buildDefaultOutputPath("webp", customTmpEnv, "image")
    const defaultImg2 = buildDefaultOutputPath("webp", customTmpEnv, "image")
    expect(path.dirname(defaultImg1)).toBe(expectedDir)
    expect(path.basename(defaultImg1)).toMatch(
      /^image-\d{8}-\d{6}-[0-9a-f]{8}\.webp$/u,
    )
    expect(defaultImg1).not.toBe(defaultImg2)

    const defaultBatch1 = buildDefaultBatchOutputDir(customTmpEnv)
    const defaultBatch2 = buildDefaultBatchOutputDir(customTmpEnv)
    expect(path.dirname(defaultBatch1)).toBe(expectedDir)
    expect(path.basename(defaultBatch1)).toMatch(
      /^batch-\d{8}-\d{6}-[0-9a-f]{8}$/u,
    )
    expect(defaultBatch1).not.toBe(defaultBatch2)
  })
})

describe("copilot-api-imagegen CLI", () => {
  test("prints help text and dry-run previews for generate, edit, and generate-batch without leaking keys", async () => {
    let help = ""
    expect(
      await runImageGen(["--help"], {
        stdout: (chunk) => {
          help += chunk
        },
      }),
    ).toBeNull()
    expect(help).toContain("GITHUB_COPILOT_API_KEY")

    const promptFile = path.join(tempDir, "prompt.txt")
    fs.writeFileSync(promptFile, "A campfire")

    let out = ""
    const res = await runImageGen(
      [
        "generate",
        "--auto-model",
        "--prompt-file",
        promptFile,
        "--output-format",
        "gif",
        "--frame-count",
        "10",
        "--frame-duration-ms",
        "120",
        "--out",
        path.join(tempDir, "campfire.gif"),
        "--dry-run",
      ],
      {
        env: { GITHUB_COPILOT_API_KEY: "secret-image-key" },
        stdout: (chunk) => {
          out += chunk
        },
        stderr: () => {},
      },
    )

    expect(res?.dryRun).toBe(true)
    expect(out).not.toContain("secret-image-key")
    const preview = JSON.parse(out) as {
      payload: Record<string, unknown>
      auth: string
    }
    expect(preview.auth).toContain("[REDACTED]")
    expect(preview.payload).not.toHaveProperty("model")
    expect(preview.payload).toMatchObject({
      output_format: "gif",
      frame_count: 10,
      frame_duration_ms: 120,
    })

    // Edit dry-run
    const imgPath = path.join(tempDir, "src.png")
    const maskPath = path.join(tempDir, "mask.jpg")
    fs.writeFileSync(imgPath, PNG_BYTES)
    fs.writeFileSync(maskPath, JPEG_BYTES)
    let editOut = ""
    let editErr = ""
    const editRes = await runImageGen(
      [
        "edit",
        "--image",
        imgPath,
        "--mask",
        maskPath,
        "--prompt",
        "Edit dry run",
        "--dry-run",
      ],
      {
        env: {},
        stdout: (chunk) => {
          editOut += chunk
        },
        stderr: (chunk) => {
          editErr += chunk
        },
      },
    )
    expect(editRes?.dryRun).toBe(true)
    expect(editErr).toContain("Mask should be a PNG")
    expect(JSON.parse(editOut)).toMatchObject({
      dry_run: true,
      transport: "multipart",
    })

    // Batch dry-run
    const jsonlPath = path.join(tempDir, "dry-batch.jsonl")
    fs.writeFileSync(jsonlPath, '{"prompt":"One","out":"one"}\n')
    let batchOut = ""
    const batchRes = await runImageGen(
      [
        "generate-batch",
        "--input",
        jsonlPath,
        "--out-dir",
        path.join(tempDir, "dry-out"),
        "--dry-run",
      ],
      {
        env: { GITHUB_COPILOT_API_KEY: "secret-batch-key" },
        stdout: (chunk) => {
          batchOut += chunk
        },
        stderr: () => {},
      },
    )
    expect(batchRes?.dryRun).toBe(true)
    expect(batchOut).not.toContain("secret-batch-key")
    expect(batchRes?.totalJobs).toBe(1)
  })

  test("rejects invalid CLI options, missing files, and missing key for remote gateways", async () => {
    await expectReject(runImageGen(["unknown"]), CliError)
    await expectReject(runImageGen(["generate"]), CliError)
    await expectReject(
      runImageGen(["generate", "--prompt", "a", "--prompt-file", "b"]),
      CliError,
    )
    await expectReject(
      runImageGen(["generate", "--prompt", "a", "--augment", "--no-augment"]),
      CliError,
    )
    await expectReject(runImageGen(["edit", "--prompt", "a"]), CliError)
    await expectReject(
      runImageGen(["edit", "--image", "/no/such/file.png", "--prompt", "a"]),
      /not found/u,
    )
    await expectReject(
      runImageGen(["generate-batch", "--out-dir", tempDir]),
      /--input/u,
    )
    await expectReject(
      runImageGen(
        [
          "generate",
          "--prompt",
          "remote",
          "--base-url",
          "https://gw.example.com",
        ],
        { env: {} },
      ),
      /GITHUB_COPILOT_API_KEY/u,
    )
  })

  test("writes default generate, edit, and generate-batch outputs into OS temp dir without colliding", async () => {
    const customTmpEnv = {
      GITHUB_COPILOT_API_KEY: "gw-key",
      TEMP: tempDir,
      TMP: tempDir,
      TMPDIR: tempDir,
    }
    const expectedDir = path.join(path.resolve(tempDir), DEFAULT_OUTPUT_SUBDIR)

    let help = ""
    await runImageGen(["--help"], {
      env: customTmpEnv,
      stdout: (chunk) => {
        help += chunk
      },
    })
    expect(help).toContain(expectedDir)

    const mockFetch = () =>
      Promise.resolve(
        Response.json({
          data: [{ b64_json: PNG_BYTES.toString("base64") }],
        }),
      )

    const gen1 = await runImageGen(["generate", "--prompt", "First default"], {
      env: customTmpEnv,
      fetch: mockFetch,
      stdout: () => {},
      stderr: () => {},
    })
    const gen2 = await runImageGen(["generate", "--prompt", "Second default"], {
      env: customTmpEnv,
      fetch: mockFetch,
      stdout: () => {},
      stderr: () => {},
    })
    expect(gen1?.outputs).toHaveLength(1)
    expect(gen2?.outputs).toHaveLength(1)
    const out1 = gen1?.outputs[0] ?? ""
    const out2 = gen2?.outputs[0] ?? ""
    expect(path.dirname(out1)).toBe(expectedDir)
    expect(path.dirname(out2)).toBe(expectedDir)
    expect(out1).not.toBe(out2)
    expect(fs.readFileSync(out1)).toEqual(PNG_BYTES)
    expect(fs.readFileSync(out2)).toEqual(PNG_BYTES)

    const edited = await runImageGen(
      ["edit", "--image", out1, "--prompt", "Edit default"],
      {
        env: customTmpEnv,
        fetch: mockFetch,
        stdout: () => {},
        stderr: () => {},
      },
    )
    const editOut = edited?.outputs[0] ?? ""
    expect(path.dirname(editOut)).toBe(expectedDir)
    expect(path.basename(editOut)).toMatch(/^edit-/u)
    expect(fs.readFileSync(editOut)).toEqual(PNG_BYTES)

    const jsonlPath = path.join(tempDir, "default-batch.jsonl")
    fs.writeFileSync(
      jsonlPath,
      JSON.stringify({ prompt: "Batch item", out: "item.png" }),
    )
    let batchJson = ""
    const batchRes = await runImageGen(
      ["generate-batch", "--input", jsonlPath, "--json"],
      {
        env: customTmpEnv,
        fetch: mockFetch,
        stdout: (chunk) => {
          batchJson += chunk
        },
        stderr: () => {},
      },
    )
    const parsedBatch = JSON.parse(batchJson) as {
      out_dir: string
      outputs: string[]
    }
    expect(path.dirname(parsedBatch.out_dir)).toBe(expectedDir)
    expect(path.basename(parsedBatch.out_dir)).toMatch(/^batch-/u)
    expect(batchRes?.outputs).toEqual([
      path.join(parsedBatch.out_dir, "item.png"),
    ])
    expect(fs.readFileSync(path.join(parsedBatch.out_dir, "item.png"))).toEqual(
      PNG_BYTES,
    )
  })

  test("generates images from b64_json and remote URLs without forwarding auth to CDN", async () => {
    const outB64 = path.join(tempDir, "b64.png")
    const outUrl = path.join(tempDir, "from-url.png")
    const seenRequests: Array<{ url: string; auth: string | null }> = []

    const mockFetch = (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const url = fetchUrl(input)
      const headers = new Headers(init?.headers)
      seenRequests.push({ url, auth: headers.get("authorization") })

      if (url.endsWith("/v1/images/generations")) {
        const body = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as { prompt: string }
        if (body.prompt.includes("URL")) {
          return Promise.resolve(
            Response.json({
              data: [
                {
                  url: "https://cdn.example.com/result.png",
                  revised_prompt: "Revised URL prompt",
                },
              ],
            }),
          )
        }
        return Promise.resolve(
          Response.json({
            data: [{ b64_json: PNG_BYTES.toString("base64") }],
          }),
        )
      }
      if (url === "https://cdn.example.com/result.png") {
        return Promise.resolve(
          new Response(PNG_BYTES, {
            headers: { "content-type": "image/png" },
          }),
        )
      }
      return Promise.resolve(new Response("not found", { status: 404 }))
    }

    let jsonOut = ""
    const res1 = await runImageGen(
      ["generate", "--prompt", "A mug", "--out", outB64, "--json"],
      {
        env: { GITHUB_COPILOT_API_KEY: "gw-img-key" },
        fetch: mockFetch,
        stdout: (chunk) => {
          jsonOut += chunk
        },
        stderr: () => {},
      },
    )
    expect(res1?.outputs).toEqual([outB64])
    expect(fs.readFileSync(outB64)).toEqual(PNG_BYTES)
    expect(JSON.parse(jsonOut)).toMatchObject({ outputs: [outB64] })

    // Existing file rejected without --force
    await expectReject(
      runImageGen(["generate", "--prompt", "A mug", "--out", outB64], {
        env: { GITHUB_COPILOT_API_KEY: "gw-img-key" },
        fetch: mockFetch,
        stdout: () => {},
        stderr: () => {},
      }),
      /already exists/u,
    )

    const res2 = await runImageGen(
      ["generate", "--prompt", "Return URL image", "--out", outUrl],
      {
        env: { GITHUB_COPILOT_API_KEY: "gw-img-key" },
        fetch: mockFetch,
        stdout: () => {},
        stderr: () => {},
      },
    )
    expect(res2?.outputs).toEqual([outUrl])
    expect(res2?.revisedPrompts).toEqual(["Revised URL prompt"])
    expect(fs.readFileSync(outUrl)).toEqual(PNG_BYTES)

    const cdnReq = seenRequests.find(
      (req) => req.url === "https://cdn.example.com/result.png",
    )
    expect(cdnReq?.auth).toBeNull()
    expect(seenRequests[0]?.auth).toBe("Bearer gw-img-key")
  })

  test("handles 401 auth hint, unsafe CDN URLs, and network retries cleanly", async () => {
    const authFetch = () =>
      Promise.resolve(
        Response.json({ error: { message: "Unauthorized" } }, { status: 401 }),
      )
    await expectReject(
      runImageGen(
        ["generate", "--prompt", "hi", "--out", path.join(tempDir, "a.png")],
        { env: {}, fetch: authFetch, stdout: () => {}, stderr: () => {} },
      ),
      /Set GITHUB_COPILOT_API_KEY/u,
    )

    const unsafeUrlFetch = () =>
      Promise.resolve(Response.json({ data: [{ url: "file:///etc/passwd" }] }))
    await expectReject(
      runImageGen(
        ["generate", "--prompt", "hi", "--out", path.join(tempDir, "b.png")],
        {
          env: { GITHUB_COPILOT_API_KEY: "k" },
          fetch: unsafeUrlFetch,
          stdout: () => {},
          stderr: () => {},
        },
      ),
      /unsafe image URL/u,
    )

    let tries = 0
    const flakyFetch = () => {
      tries += 1
      return Promise.reject(new Error("ECONNRESET"))
    }
    await expectReject(
      runImageGen(
        [
          "generate",
          "--prompt",
          "hi",
          "--max-attempts",
          "2",
          "--out",
          path.join(tempDir, "c.png"),
        ],
        {
          env: { GITHUB_COPILOT_API_KEY: "k" },
          fetch: flakyFetch,
          sleep: () => Promise.resolve(),
          stdout: () => {},
          stderr: () => {},
        },
      ),
      /failed after 2 attempt/u,
    )
    expect(tries).toBe(2)
  })

  test("edits images via multipart (verified by copilot-api multipart parser) and json transport", async () => {
    const img1 = path.join(tempDir, "base.png")
    const mask = path.join(tempDir, "mask.png")
    fs.writeFileSync(img1, PNG_BYTES)
    fs.writeFileSync(mask, PNG_BYTES)

    let parsedMultipartBody: Record<string, unknown> | undefined
    const mockFetch = async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const request = new Request(fetchUrl(input), init)
      if (
        request.headers.get("content-type")?.startsWith("multipart/form-data")
      ) {
        const parsed = await parseMultipartImageEdit(request)
        if (!parsed) throw new Error("Expected multipart edit")
        try {
          parsedMultipartBody = await parsed.readPayload()
        } finally {
          await parsed.cleanup()
        }
      } else {
        parsedMultipartBody = (await request.json()) as Record<string, unknown>
      }
      return Response.json({
        data: [{ b64_json: PNG_BYTES.toString("base64") }],
      })
    }

    const outMultipart = path.join(tempDir, "edited-multipart.png")
    await runImageGen(
      [
        "edit",
        "--model",
        "gpt-image-1.5",
        "--image",
        img1,
        "--image",
        "https://example.com/style.png",
        "--mask",
        mask,
        "--input-fidelity",
        "high",
        "--prompt",
        "Replace background",
        "--out",
        outMultipart,
        "--json",
      ],
      {
        env: { GITHUB_COPILOT_API_KEY: "gw-key" },
        fetch: mockFetch,
        stdout: () => {},
        stderr: () => {},
      },
    )

    expect(parsedMultipartBody).toMatchObject({
      model: "gpt-image-1.5",
      prompt: "Replace background",
      input_fidelity: "high",
      images: [
        { image_url: `data:image/png;base64,${PNG_BYTES.toString("base64")}` },
        { image_url: "https://example.com/style.png" },
      ],
      mask: {
        image_url: `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
      },
    })
    expect(fs.readFileSync(outMultipart)).toEqual(PNG_BYTES)

    const outJson = path.join(tempDir, "edited-json.png")
    await runImageGen(
      [
        "edit",
        "--transport",
        "json",
        "--image",
        img1,
        "--prompt",
        "Add steam",
        "--out",
        outJson,
      ],
      {
        env: { GITHUB_COPILOT_API_KEY: "gw-key" },
        fetch: mockFetch,
        stdout: () => {},
        stderr: () => {},
      },
    )
    expect(parsedMultipartBody).toMatchObject({
      model: "gpt-image-2",
      prompt: "Add steam",
      images: [
        { image_url: `data:image/png;base64,${PNG_BYTES.toString("base64")}` },
      ],
    })
  })

  test("runs generate-batch concurrently with retries, fail-fast, and path traversal guard", async () => {
    const jsonlPath = path.join(tempDir, "jobs.jsonl")
    const outDir = path.join(tempDir, "batch-out")
    fs.writeFileSync(
      jsonlPath,
      [
        "# comment line",
        JSON.stringify({
          prompt: "First scene",
          size: "1024x1024",
          out: "first.png",
          style: "minimal",
        }),
        "Second bare prompt",
      ].join("\n"),
    )

    let attempts = 0
    const mockFetch = (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      attempts += 1
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as { prompt: string }
      if (attempts === 1 && body.prompt.includes("First")) {
        return Promise.resolve(
          Response.json({ error: { message: "busy" } }, { status: 429 }),
        )
      }
      return Promise.resolve(
        Response.json({
          data: [{ b64_json: PNG_BYTES.toString("base64") }],
        }),
      )
    }

    const res = await runImageGen(
      [
        "generate-batch",
        "--input",
        jsonlPath,
        "--out-dir",
        outDir,
        "--concurrency",
        "2",
        "--json",
      ],
      {
        env: { GITHUB_COPILOT_API_KEY: "gw-key" },
        fetch: mockFetch,
        sleep: () => Promise.resolve(),
        stdout: () => {},
        stderr: () => {},
      },
    )

    expect(res?.totalJobs).toBe(2)
    expect(res?.failedJobs).toBe(0)
    expect(res?.outputs).toHaveLength(2)
    expect(fs.existsSync(path.join(outDir, "first.png"))).toBe(true)

    // Batch fail-fast on HTTP 400 reports accurate succeeded/failed/skipped counts
    const failDir = path.join(tempDir, "fail-out")
    const failFetch = () =>
      Promise.resolve(
        Response.json({ error: { message: "bad prompt" } }, { status: 400 }),
      )
    let failJson = ""
    await expectReject(
      runImageGen(
        [
          "generate-batch",
          "--input",
          jsonlPath,
          "--out-dir",
          failDir,
          "--concurrency",
          "1",
          "--fail-fast",
          "--json",
        ],
        {
          env: { GITHUB_COPILOT_API_KEY: "gw-key" },
          fetch: failFetch,
          stdout: (chunk) => {
            failJson += chunk
          },
          stderr: () => {},
        },
      ),
      /batch job\(s\) failed/u,
    )
    expect(JSON.parse(failJson)).toMatchObject({
      total_jobs: 2,
      succeeded_jobs: 0,
      failed_jobs: 1,
      skipped_jobs: 1,
      outputs: [],
    })

    // Duplicate output filenames in the same batch must fail before any network call
    const dupJsonl = path.join(tempDir, "dup.jsonl")
    fs.writeFileSync(
      dupJsonl,
      [
        JSON.stringify({ prompt: "First", out: "same.png" }),
        JSON.stringify({ prompt: "Second", out: "same.png" }),
      ].join("\n"),
    )
    let dupFetchCalled = false
    await expectReject(
      runImageGen(
        ["generate-batch", "--input", dupJsonl, "--out-dir", outDir],
        {
          env: { GITHUB_COPILOT_API_KEY: "gw-key" },
          fetch: () => {
            dupFetchCalled = true
            return Promise.resolve(Response.json({ data: [] }))
          },
          stdout: () => {},
          stderr: () => {},
        },
      ),
      /Duplicate batch output path/u,
    )
    expect(dupFetchCalled).toBe(false)

    // Path traversal in job `out` must be rejected before any network call
    const badJsonl = path.join(tempDir, "bad.jsonl")
    fs.writeFileSync(
      badJsonl,
      JSON.stringify({ prompt: "Escape", out: "../escape.png" }),
    )
    await expectReject(
      runImageGen(
        ["generate-batch", "--input", badJsonl, "--out-dir", outDir],
        {
          env: { GITHUB_COPILOT_API_KEY: "gw-key" },
          fetch: mockFetch,
          stdout: () => {},
          stderr: () => {},
        },
      ),
      /plain filename/u,
    )
  })

  test("omits default gpt-image-2 when --provider is specified, rejects incompatible flags, and redacts credentialed CDN URLs", async () => {
    let copilotOut = ""
    await runImageGen(
      [
        "generate",
        "--provider",
        "github-copilot",
        "--prompt",
        "Hero",
        "--dry-run",
      ],
      {
        env: { GITHUB_COPILOT_API_KEY: "gw-key" },
        stdout: (chunk) => {
          copilotOut += chunk
        },
        stderr: () => {},
      },
    )
    const copilotPreview = JSON.parse(copilotOut) as {
      endpoint: string
      payload: Record<string, unknown>
    }
    expect(copilotPreview.endpoint).toBe(
      "http://localhost:4141/github-copilot/v1/images/generations",
    )
    expect(copilotPreview.payload).not.toHaveProperty("model")

    // --provider github-copilot --output-format gif without --model must still reject GIF
    await expectReject(
      runImageGen([
        "generate",
        "--provider",
        "github-copilot",
        "--prompt",
        "Anim",
        "--output-format",
        "gif",
        "--dry-run",
      ]),
      /Flare.*GIF/u,
    )

    // Per-job provider in generate-batch omits gpt-image-2 when CLI --model is unset
    const providerBatch = path.join(tempDir, "provider-batch.jsonl")
    fs.writeFileSync(
      providerBatch,
      JSON.stringify({ prompt: "Xai job", provider: "xai", out: "x.png" }),
    )
    let batchDry = ""
    await runImageGen(
      [
        "generate-batch",
        "--input",
        providerBatch,
        "--out-dir",
        path.join(tempDir, "p-out"),
        "--dry-run",
      ],
      {
        env: { GITHUB_COPILOT_API_KEY: "gw-key" },
        stdout: (chunk) => {
          batchDry += chunk
        },
        stderr: () => {},
      },
    )
    const batchPreview = JSON.parse(batchDry) as {
      jobs: Array<{ endpoint: string; payload: Record<string, unknown> }>
    }
    expect(batchPreview.jobs[0]?.endpoint).toBe(
      "http://localhost:4141/xai/v1/images/generations",
    )
    expect(batchPreview.jobs[0]?.payload).not.toHaveProperty("model")

    // Incompatible subcommand flags & whitespace-only --image
    await expectReject(
      runImageGen(["generate", "--prompt", "hi", "--image", "a.png"]),
      /only valid for the `edit`/u,
    )
    await expectReject(
      runImageGen(["edit", "--prompt", "hi", "--image", "   "]),
      /at least one --image/u,
    )
    await expectReject(
      runImageGen([
        "generate-batch",
        "--prompt",
        "hi",
        "--input",
        providerBatch,
        "--out-dir",
        tempDir,
      ]),
      /Use --input/u,
    )

    // Credentialed image URL must not echo password in error message
    let caughtError = ""
    try {
      await runImageGen(
        [
          "generate",
          "--prompt",
          "cred",
          "--out",
          path.join(tempDir, "cred.png"),
        ],
        {
          env: { GITHUB_COPILOT_API_KEY: "gw-key" },
          fetch: () =>
            Promise.resolve(
              Response.json({
                data: [
                  { url: "https://user:top-secret-pw@cdn.example.com/a.png" },
                ],
              }),
            ),
          stdout: () => {},
          stderr: () => {},
        },
      )
    } catch (error) {
      caughtError = error instanceof Error ? error.message : String(error)
    }
    expect(caughtError).toContain("embedded credentials")
    expect(caughtError).not.toContain("top-secret-pw")
  })
})
