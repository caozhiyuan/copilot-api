import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildDefaultOutputPath,
  CliError,
  DEFAULT_OUTPUT_SUBDIR,
  isLoopbackUrl,
  normalizeBaseUrl,
  parseVideoStatus,
  resolveDefaultOutputDir,
  runVideoGen,
  validateMediaUrl,
  validateRequestId,
} from "../.agents/skills/copilot-api-videogen/scripts/video_gen.mjs"
import type { ResolvedProviderConfig } from "~/lib/config"
import { closeUsageStore } from "~/lib/token-usage"
import { videoRouteDependencies } from "~/routes/videos/route"
import { createServer } from "~/server"

const PNG_BYTES = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
])
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP"),
])
const FAKE_MP4 = Buffer.from("00000018ftypmp42")

const originalVideoDeps = { ...videoRouteDependencies }
const originalGlobalFetch = globalThis.fetch
const originalDbPath = process.env.COPILOT_API_SQLITE_DB_PATH
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-skill-videogen-"))
})

afterEach(async () => {
  await closeUsageStore()
  Object.assign(videoRouteDependencies, originalVideoDeps)
  globalThis.fetch = originalGlobalFetch
  if (originalDbPath === undefined) {
    Reflect.deleteProperty(process.env, "COPILOT_API_SQLITE_DB_PATH")
  } else {
    process.env.COPILOT_API_SQLITE_DB_PATH = originalDbPath
  }
  await fs.promises.rm(tempDir, { recursive: true, force: true })
})

describe("copilot-api-videogen helpers", () => {
  test("validates base URLs, request IDs, and media URLs", () => {
    expect(normalizeBaseUrl(undefined)).toBe("http://localhost:4141")
    expect(normalizeBaseUrl("http://127.0.0.1:4141/v1/")).toBe(
      "http://127.0.0.1:4141",
    )
    expect(() => normalizeBaseUrl("ftp://localhost:4141")).toThrow(CliError)
    expect(() => normalizeBaseUrl("http://u:p@localhost:4141")).toThrow(
      CliError,
    )
    expect(() => normalizeBaseUrl("not-a-url")).toThrow(CliError)
    expect(isLoopbackUrl("http://localhost:4141")).toBe(true)
    expect(isLoopbackUrl("https://gateway.example.com")).toBe(false)

    expect(validateRequestId("job-123")).toBe("job-123")
    expect(() => validateRequestId("..")).toThrow(CliError)
    expect(() => validateRequestId("a/b")).toThrow(CliError)
    expect(() => validateRequestId("   ")).toThrow(CliError)

    expect(validateMediaUrl("https://vidgen.x.ai/clip.mp4")).toBe(
      "https://vidgen.x.ai/clip.mp4",
    )
    expect(() => validateMediaUrl("file:///etc/passwd")).toThrow(CliError)
    expect(() =>
      validateMediaUrl("https://user:pass@vidgen.x.ai/clip.mp4"),
    ).toThrow(CliError)

    expect(resolveDefaultOutputDir({})).toBe(
      path.join(path.resolve(os.tmpdir()), DEFAULT_OUTPUT_SUBDIR),
    )
    const customTmpEnv = { TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir }
    const expectedDir = path.join(path.resolve(tempDir), DEFAULT_OUTPUT_SUBDIR)
    expect(resolveDefaultOutputDir(customTmpEnv)).toBe(expectedDir)
    const defaultVid1 = buildDefaultOutputPath(customTmpEnv)
    const defaultVid2 = buildDefaultOutputPath(customTmpEnv)
    expect(path.dirname(defaultVid1)).toBe(expectedDir)
    expect(path.basename(defaultVid1)).toMatch(
      /^video-\d{8}-\d{6}-[0-9a-f]{8}\.mp4$/u,
    )
    expect(defaultVid1).not.toBe(defaultVid2)
  })

  test("parses pending, done, moderated, failed, and expired statuses", () => {
    expect(parseVideoStatus({ request_id: "req-1" })).toMatchObject({
      status: "pending",
      requestId: "req-1",
    })
    expect(
      parseVideoStatus({ status: "processing", progress: 45 }),
    ).toMatchObject({
      status: "pending",
      progress: 45,
    })
    expect(
      parseVideoStatus({
        status: "done",
        video: {
          url: "https://vidgen.x.ai/clip.mp4",
          duration: 8,
          respect_moderation: true,
        },
        model: "grok-imagine-video-1.5",
      }),
    ).toMatchObject({
      status: "done",
      url: "https://vidgen.x.ai/clip.mp4",
      duration: 8,
    })
    expect(
      parseVideoStatus({
        status: "done",
        video: {
          url: "https://vidgen.x.ai/clip.mp4",
          respect_moderation: false,
        },
      }),
    ).toMatchObject({
      status: "failed",
      error: "The video was filtered by moderation",
    })
    expect(
      parseVideoStatus({
        status: "failed",
        error: { message: "bad input" },
      }),
    ).toMatchObject({
      status: "failed",
      error: "bad input",
    })
    expect(parseVideoStatus({ status: "expired" })).toMatchObject({
      status: "expired",
    })
    expect(() => parseVideoStatus({ status: "done", video: {} })).toThrow(
      CliError,
    )
    expect(() => parseVideoStatus({ status: "unknown" })).toThrow(CliError)
  })
})

describe("copilot-api-videogen CLI", () => {
  test("prints help and previews generate/status/wait dry-runs safely", async () => {
    let help = ""
    expect(
      await runVideoGen(["--help"], {
        stdout: (chunk) => {
          help += chunk
        },
      }),
    ).toBeNull()
    expect(help).toContain("GITHUB_COPILOT_API_KEY")

    const imgPath = path.join(tempDir, "first.png")
    const jpegPath = path.join(tempDir, "ref.jpg")
    const webpPath = path.join(tempDir, "last.webp")
    const promptPath = path.join(tempDir, "prompt.txt")
    fs.writeFileSync(imgPath, PNG_BYTES)
    fs.writeFileSync(jpegPath, JPEG_BYTES)
    fs.writeFileSync(webpPath, WEBP_BYTES)
    fs.writeFileSync(promptPath, "Animate <IMAGE_0> with <IMAGE_1>")

    let out = ""
    let err = ""
    const res = await runVideoGen(
      [
        "generate",
        "--image",
        imgPath,
        "--last-frame",
        webpPath,
        "--ref-image",
        jpegPath,
        "--prompt-file",
        promptPath,
        "--duration",
        "6",
        "--resolution",
        "1080p",
        "--no-audio",
        "--extra-json",
        '{"storage_options":{"persist":false}}',
        "--out",
        path.join(tempDir, "out.mp4"),
        "--dry-run",
      ],
      {
        env: { GITHUB_COPILOT_API_KEY: "secret-video-key" },
        stdout: (chunk) => {
          out += chunk
        },
        stderr: (chunk) => {
          err += chunk
        },
      },
    )

    expect(res?.dryRun).toBe(true)
    expect(out).not.toContain("secret-video-key")
    expect(err).toContain("720p")
    const preview = JSON.parse(out) as {
      auth: string
      payload: Record<string, unknown>
    }
    expect(preview.auth).toContain("[REDACTED]")
    expect(preview.payload).toMatchObject({
      model: "xai/grok-imagine-video-1.5",
      duration: 6,
      resolution: "1080p",
      generate_audio: false,
      storage_options: { persist: false },
    })

    // Status dry-run
    let statusDry = ""
    const statusRes = await runVideoGen(
      ["status", "--request-id", "job-abc", "--download", "--dry-run"],
      {
        env: {},
        stdout: (chunk) => {
          statusDry += chunk
        },
        stderr: () => {},
      },
    )
    expect(statusRes?.dryRun).toBe(true)
    expect(JSON.parse(statusDry)).toMatchObject({
      command: "status",
      request_id: "job-abc",
    })
  })

  test("validates errors and refuses existing --out before submitting a paid job", async () => {
    await expectReject(runVideoGen(["unknown"]), CliError)
    await expectReject(runVideoGen(["generate"]), CliError)
    await expectReject(
      runVideoGen(["generate", "--prompt", "hi", "--duration", "20"]),
      CliError,
    )
    await expectReject(
      runVideoGen(["generate", "--prompt", "hi", "--audio", "--no-audio"]),
      CliError,
    )
    await expectReject(
      runVideoGen(["generate", "--prompt", "hi", "--extra-json", "[]"]),
      CliError,
    )
    await expectReject(
      runVideoGen(["generate", "--prompt", "hi", "--extra-json", "{bad"]),
      CliError,
    )
    await expectReject(runVideoGen(["status"]), CliError)
    await expectReject(
      runVideoGen(
        ["generate", "--prompt", "hi", "--base-url", "https://gw.example.com"],
        { env: {} },
      ),
      /GITHUB_COPILOT_API_KEY/u,
    )

    const badImg = path.join(tempDir, "bad.bin")
    fs.writeFileSync(badImg, Buffer.from("not-an-image"))
    await expectReject(
      runVideoGen(["generate", "--image", badImg]),
      /Unsupported image format/u,
    )

    const existingOut = path.join(tempDir, "exists.mp4")
    fs.writeFileSync(existingOut, FAKE_MP4)
    let fetchCalled = false
    await expectReject(
      runVideoGen(["generate", "--prompt", "hi", "--out", existingOut], {
        env: { GITHUB_COPILOT_API_KEY: "gw-key" },
        fetch: () => {
          fetchCalled = true
          return Promise.resolve(
            Response.json({ request_id: "should-not-run" }),
          )
        },
        stderr: () => {},
      }),
      /already exists/u,
    )
    expect(fetchCalled).toBe(false)
  })

  test("submits, polls through transient errors to done, and downloads MP4 without forwarding auth header", async () => {
    const outPath = path.join(tempDir, "nested", "clip.mp4")
    const seen: Array<{ url: string; method: string; auth: string | null }> = []
    let pollCount = 0

    const mockFetch = (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const url = fetchUrl(input)
      const method = init?.method ?? "GET"
      const headers = new Headers(init?.headers)
      seen.push({ url, method, auth: headers.get("authorization") })

      if (url.endsWith("/v1/videos/generations")) {
        return Promise.resolve(Response.json({ request_id: "vid-job-42" }))
      }
      if (url.endsWith("/v1/videos/vid-job-42")) {
        pollCount += 1
        if (pollCount === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: { message: "busy" } }), {
              status: 429,
              headers: { "retry-after": "0" },
            }),
          )
        }
        if (pollCount === 2) {
          return Promise.resolve(
            Response.json({ status: "pending", progress: 40 }),
          )
        }
        return Promise.resolve(
          Response.json({
            status: "done",
            model: "grok-imagine-video-1.5",
            video: {
              url: "https://vidgen.x.ai/vid-job-42.mp4",
              duration: 5,
              respect_moderation: true,
            },
          }),
        )
      }
      if (url === "https://vidgen.x.ai/vid-job-42.mp4") {
        return Promise.resolve(
          new Response(FAKE_MP4, { headers: { "content-type": "video/mp4" } }),
        )
      }
      return Promise.resolve(new Response("not found", { status: 404 }))
    }

    let out = ""
    const res = await runVideoGen(
      [
        "generate",
        "--prompt",
        "Paper boat on a lake",
        "--duration",
        "5",
        "--aspect-ratio",
        "16:9",
        "--resolution",
        "720p",
        "--audio",
        "--poll-interval-ms",
        "10",
        "--out",
        outPath,
        "--json",
      ],
      {
        env: { GITHUB_COPILOT_API_KEY: "gw-video-secret" },
        fetch: mockFetch,
        sleep: () => Promise.resolve(),
        stdout: (chunk) => {
          out += chunk
        },
        stderr: () => {},
      },
    )

    expect(res?.status).toBe("done")
    expect(res?.requestId).toBe("vid-job-42")
    expect(res?.outPath).toBe(outPath)
    expect(fs.readFileSync(outPath)).toEqual(FAKE_MP4)
    expect(JSON.parse(out)).toMatchObject({
      request_id: "vid-job-42",
      status: "done",
      out: outPath,
    })

    const cdnCall = seen.find(
      (call) => call.url === "https://vidgen.x.ai/vid-job-42.mp4",
    )
    expect(cdnCall?.auth).toBeNull()
    expect(seen[0]?.auth).toBe("Bearer gw-video-secret")
    expect(seen[1]?.auth).toBe("Bearer gw-video-secret")
  })

  test("supports submit, status --download, moderation/failed errors, and wait resume hint on timeout", async () => {
    const outStatus = path.join(tempDir, "status-dl.mp4")
    const mockFetch = (input: Parameters<typeof fetch>[0]) => {
      const url = fetchUrl(input)
      if (url.endsWith("/v1/videos/generations")) {
        return Promise.resolve(Response.json({ request_id: "async-99" }))
      }
      if (url.endsWith("/v1/videos/done-job")) {
        return Promise.resolve(
          Response.json({
            status: "done",
            video: {
              url: "https://vidgen.x.ai/done.mp4",
              duration: 5,
              respect_moderation: true,
            },
          }),
        )
      }
      if (url.endsWith("/v1/videos/mod-job")) {
        return Promise.resolve(
          Response.json({
            status: "done",
            video: {
              url: "https://vidgen.x.ai/mod.mp4",
              respect_moderation: false,
            },
          }),
        )
      }
      if (url === "https://vidgen.x.ai/done.mp4") {
        return Promise.resolve(new Response(FAKE_MP4))
      }
      return Promise.resolve(Response.json({ status: "pending", progress: 10 }))
    }

    const submitted = await runVideoGen(
      ["submit", "--prompt", "Ocean waves", "--json"],
      {
        env: { GITHUB_COPILOT_API_KEY: "gw-key" },
        fetch: mockFetch,
        stdout: () => {},
        stderr: () => {},
      },
    )
    expect(submitted?.requestId).toBe("async-99")
    expect(submitted?.status).toBe("pending")

    const checked = await runVideoGen(
      ["status", "--request-id", "done-job", "--download", "--out", outStatus],
      {
        env: { GITHUB_COPILOT_API_KEY: "gw-key" },
        fetch: mockFetch,
        stdout: () => {},
        stderr: () => {},
      },
    )
    expect(checked?.status).toBe("done")
    expect(fs.readFileSync(outStatus)).toEqual(FAKE_MP4)

    await expectReject(
      runVideoGen(["status", "--request-id", "mod-job", "--json"], {
        env: { GITHUB_COPILOT_API_KEY: "gw-key" },
        fetch: mockFetch,
        stdout: () => {},
        stderr: () => {},
      }),
      /filtered by moderation/u,
    )

    let clock = 1000
    await expectReject(
      runVideoGen(
        [
          "wait",
          "--request-id",
          "async-99",
          "--poll-interval-ms",
          "50",
          "--timeout-ms",
          "100",
        ],
        {
          env: { GITHUB_COPILOT_API_KEY: "gw-key" },
          fetch: mockFetch,
          now: () => clock,
          sleep: (ms) => {
            clock += ms + 100
            return Promise.resolve()
          },
          stdout: () => {},
          stderr: () => {},
        },
      ),
      /wait --request-id async-99/u,
    )
  })

  test("integrates end-to-end with copilot-api createServer() video routes", async () => {
    process.env.COPILOT_API_SQLITE_DB_PATH = ":memory:"
    const providerConfig: ResolvedProviderConfig = {
      name: "xai",
      type: "openai-responses",
      baseUrl: "https://api.x.ai",
      apiKey: "xai-upstream-key",
      authType: "authorization",
    }
    videoRouteDependencies.resolveMappedModel = (model) => model
    videoRouteDependencies.resolveProviderConfig = () =>
      Promise.resolve(providerConfig)

    const upstreamFetch = (input: Parameters<typeof fetch>[0]) => {
      const url = fetchUrl(input)
      if (url === "https://api.x.ai/v1/videos/generations") {
        return Promise.resolve(Response.json({ request_id: "e2e-video-1" }))
      }
      if (url === "https://api.x.ai/v1/videos/e2e-video-1") {
        return Promise.resolve(
          Response.json({
            status: "done",
            model: "grok-imagine-video-1.5",
            video: {
              url: "https://vidgen.x.ai/e2e.mp4",
              duration: 5,
              respect_moderation: true,
            },
          }),
        )
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }))
    }
    globalThis.fetch = Object.assign(upstreamFetch, {
      preconnect: () => {},
    }) as typeof fetch

    const server = createServer({ getApiKeys: () => ["gateway-video-key"] })
    const outPath = path.join(tempDir, "e2e.mp4")

    const clientFetch = (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const url = fetchUrl(input)
      if (url === "https://vidgen.x.ai/e2e.mp4") {
        return Promise.resolve(
          new Response(FAKE_MP4, { headers: { "content-type": "video/mp4" } }),
        )
      }
      const parsed = new URL(url)
      return Promise.resolve(
        server.request(`${parsed.pathname}${parsed.search}`, init),
      )
    }

    const res = await runVideoGen(
      [
        "generate",
        "--prompt",
        "Paper boat",
        "--duration",
        "5",
        "--out",
        outPath,
      ],
      {
        env: {
          GITHUB_COPILOT_API_KEY: "gateway-video-key",
          COPILOT_API_BASE_URL: "http://localhost:4141",
        },
        fetch: clientFetch,
        sleep: () => Promise.resolve(),
        stdout: () => {},
        stderr: () => {},
      },
    )

    expect(res?.status).toBe("done")
    expect(res?.requestId).toBe("e2e-video-1")
    expect(fs.readFileSync(outPath)).toEqual(FAKE_MP4)
  })

  test("redacts credentialed URLs, honors --no-download in wait dry-run, warns >1 MiB local images, and does not retry POST on network error", async () => {
    let urlErr = ""
    try {
      validateMediaUrl("https://alice:video-secret-pw@vidgen.x.ai/clip.mp4")
    } catch (error) {
      urlErr = error instanceof Error ? error.message : String(error)
    }
    expect(urlErr).toContain("embedded credentials")
    expect(urlErr).not.toContain("video-secret-pw")

    await expectReject(
      runVideoGen([
        "status",
        "--request-id",
        "job-1",
        "--download",
        "--no-download",
      ]),
      /Do not pass both --download and --no-download/u,
    )

    let waitDry = ""
    await runVideoGen(
      ["wait", "--request-id", "job-1", "--no-download", "--dry-run"],
      {
        env: { GITHUB_COPILOT_API_KEY: "gw-key" },
        stdout: (chunk) => {
          waitDry += chunk
        },
        stderr: () => {},
      },
    )
    expect(JSON.parse(waitDry)).not.toHaveProperty("out")

    const largePng = path.join(tempDir, "large.png")
    fs.writeFileSync(
      largePng,
      Buffer.concat([PNG_BYTES, Buffer.alloc(1024 * 1024 + 64)]),
    )
    let warnErr = ""
    await runVideoGen(["submit", "--image", largePng, "--dry-run"], {
      env: { GITHUB_COPILOT_API_KEY: "gw-key" },
      stdout: () => {},
      stderr: (chunk) => {
        warnErr += chunk
      },
    })
    expect(warnErr).toContain("over 1 MiB")

    // Non-idempotent POST must not retry on ambiguous network disconnect
    let postAttempts = 0
    await expectReject(
      runVideoGen(["submit", "--prompt", "No duplicate billing"], {
        env: { GITHUB_COPILOT_API_KEY: "gw-key" },
        fetch: () => {
          postAttempts += 1
          return Promise.reject(new Error("ETIMEDOUT"))
        },
        sleep: () => Promise.resolve(),
        stdout: () => {},
        stderr: () => {},
      }),
      /ETIMEDOUT/u,
    )
    expect(postAttempts).toBe(1)
  })

  test("writes default generate and status --download outputs into OS temp dir without colliding", async () => {
    const spacedTmp = path.join(tempDir, "temp with spaces")
    fs.mkdirSync(spacedTmp, { recursive: true })
    const customTmpEnv = {
      GITHUB_COPILOT_API_KEY: "gw-key",
      TEMP: spacedTmp,
      TMP: spacedTmp,
      TMPDIR: spacedTmp,
    }
    const expectedDir = path.join(
      path.resolve(spacedTmp),
      DEFAULT_OUTPUT_SUBDIR,
    )

    let help = ""
    await runVideoGen(["--help"], {
      env: customTmpEnv,
      stdout: (chunk) => {
        help += chunk
      },
    })
    expect(help).toContain(expectedDir)

    const mockFetch = (input: Parameters<typeof fetch>[0]) => {
      const url = fetchUrl(input)
      if (url.endsWith("/v1/videos/generations")) {
        return Promise.resolve(Response.json({ request_id: "tmp-job-1" }))
      }
      if (url.endsWith("/v1/videos/tmp-job-1")) {
        return Promise.resolve(
          Response.json({
            status: "done",
            video: {
              url: "https://vidgen.x.ai/tmp-job-1.mp4",
              duration: 5,
              respect_moderation: true,
            },
          }),
        )
      }
      if (url.endsWith("/v1/videos/pending-space")) {
        return Promise.resolve(
          Response.json({ status: "pending", progress: 5 }),
        )
      }
      if (url === "https://vidgen.x.ai/tmp-job-1.mp4") {
        return Promise.resolve(new Response(FAKE_MP4))
      }
      return Promise.resolve(new Response("not found", { status: 404 }))
    }

    const gen1 = await runVideoGen(["generate", "--prompt", "First clip"], {
      env: customTmpEnv,
      fetch: mockFetch,
      sleep: () => Promise.resolve(),
      stdout: () => {},
      stderr: () => {},
    })
    const gen2 = await runVideoGen(
      ["status", "--request-id", "tmp-job-1", "--download"],
      {
        env: customTmpEnv,
        fetch: mockFetch,
        stdout: () => {},
        stderr: () => {},
      },
    )
    const out1 = gen1?.outPath ?? ""
    const out2 = gen2?.outPath ?? ""
    expect(path.dirname(out1)).toBe(expectedDir)
    expect(path.dirname(out2)).toBe(expectedDir)
    expect(out1).not.toBe(out2)
    expect(fs.readFileSync(out1)).toEqual(FAKE_MP4)
    expect(fs.readFileSync(out2)).toEqual(FAKE_MP4)

    let clock = 1000
    await expectReject(
      runVideoGen(
        [
          "wait",
          "--request-id",
          "pending-space",
          "--poll-interval-ms",
          "50",
          "--timeout-ms",
          "100",
        ],
        {
          env: customTmpEnv,
          fetch: mockFetch,
          now: () => clock,
          sleep: (ms) => {
            clock += ms + 100
            return Promise.resolve()
          },
          stdout: () => {},
          stderr: () => {},
        },
      ),
      /--out ".*temp with spaces/u,
    )
  })
})
