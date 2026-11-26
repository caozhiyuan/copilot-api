#!/usr/bin/env node
/**
 * CLI for asynchronous video generation, status polling, and MP4 download
 * through a running copilot-api gateway (/v1/videos/generations and
 * /v1/videos/{request_id}, backed by xai/grok-imagine-video-1.5).
 *
 * Uses zero third-party dependencies (Node.js 20+ or Bun).
 * Authentication uses GITHUB_COPILOT_API_KEY and gateway URL uses
 * COPILOT_API_BASE_URL (default: http://localhost:4141).
 */

import { randomUUID } from "node:crypto"
import { createWriteStream, existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

export const DEFAULT_BASE_URL = "http://localhost:4141"
export const DEFAULT_MODEL = "xai/grok-imagine-video-1.5"
export const DEFAULT_OUTPUT_SUBDIR = "copilot-api-videogen"
export const DEFAULT_POLL_INTERVAL_MS = 5_000
export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000
export const DEFAULT_HTTP_TIMEOUT_MS = 120_000
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000
export const DEFAULT_MAX_ATTEMPTS = 3

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {string}
 */
export function resolveDefaultOutputDir(env = process.env) {
  const envTmp =
    process.platform === "win32" ?
      env.TEMP || env.TMP
    : env.TMPDIR || env.TMP || env.TEMP
  const baseDir =
    typeof envTmp === "string" && envTmp.trim() ? envTmp.trim() : tmpdir()
  return path.join(path.resolve(baseDir), DEFAULT_OUTPUT_SUBDIR)
}

/**
 * @returns {string}
 */
function formatTimestampSlug() {
  return new Date()
    .toISOString()
    .replaceAll(/[-:]/gu, "")
    .replace("T", "-")
    .slice(0, 15)
}

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @param {string} [prefix="video"]
 * @returns {string}
 */
export function buildDefaultOutputPath(env = process.env, prefix = "video") {
  const fileName = `${prefix}-${formatTimestampSlug()}-${randomUUID().slice(0, 8)}.mp4`
  return path.join(resolveDefaultOutputDir(env), fileName)
}

const VIDEO_RATIOS = new Set([
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "21:9",
  "5:2",
])
const VIDEO_RESOLUTIONS = new Set(["480p", "720p", "1080p"])
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])
const MAX_REFERENCE_IMAGES = 14
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024

/**
 * @typedef {(input: string | URL | Request, init?: RequestInit) => Promise<Response>} FetchLike
 */

/**
 * @typedef {{
 *   env?: Record<string, string | undefined>,
 *   fetch?: FetchLike,
 *   stdout?: (text: string) => void,
 *   stderr?: (text: string) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} CliDeps
 */

/**
 * @typedef {{
 *   status: "pending" | "done" | "failed" | "expired",
 *   requestId?: string,
 *   url?: string,
 *   duration?: number,
 *   progress?: number,
 *   model?: string,
 *   error?: string,
 *   raw: Record<string, unknown>,
 * }} ParsedVideoStatus
 */

/**
 * @typedef {{
 *   command: "generate" | "submit" | "status" | "wait",
 *   endpoint: string,
 *   dryRun: boolean,
 *   requestId?: string,
 *   status?: string,
 *   videoUrl?: string,
 *   outPath?: string,
 *   raw?: Record<string, unknown>,
 * }} VideoGenRunResult
 */

export class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode=1]
   */
  constructor(message, exitCode = 1) {
    super(message)
    this.name = "CliError"
    this.exitCode = exitCode
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      /** @type {Record<string, unknown>} */ (value)
    : {}
}

/**
 * @param {string | undefined} raw
 * @returns {string}
 */
export function normalizeBaseUrl(raw) {
  const input = (raw ?? "").trim() || DEFAULT_BASE_URL
  let parsed
  try {
    parsed = new URL(input)
  } catch {
    throw new CliError(
      `Invalid base URL: ${JSON.stringify(input)}. Expected http(s)://host[:port].`,
    )
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(
      `Unsupported base URL protocol "${parsed.protocol}". Expected http: or https:.`,
    )
  }
  if (parsed.username || parsed.password) {
    throw new CliError(
      "Base URL must not contain embedded credentials; use GITHUB_COPILOT_API_KEY instead.",
    )
  }
  const normalizedPath = parsed.pathname
    .replace(/\/+$/u, "")
    .replace(/\/v1$/u, "")
  return `${parsed.origin}${normalizedPath}`
}

/**
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function isLoopbackUrl(baseUrl) {
  const { hostname } = new URL(baseUrl)
  const bare = hostname.replace(/^\[|\]$/gu, "").toLowerCase()
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1"
}

/**
 * @param {string} requestId
 * @returns {string}
 */
export function validateRequestId(requestId) {
  const trimmed = requestId.trim()
  if (
    !trimmed
    || trimmed === "."
    || trimmed === ".."
    || /[/\\?#@]/u.test(trimmed)
  ) {
    throw new CliError(
      `Invalid --request-id: ${JSON.stringify(requestId)}. Must be a single path segment.`,
    )
  }
  return trimmed
}

/**
 * @param {string} url
 * @returns {string}
 */
export function validateMediaUrl(url) {
  let parsed
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new CliError("Invalid video URL.")
  }
  if (parsed.username || parsed.password) {
    throw new CliError(
      `Unsupported or unsafe video URL with embedded credentials (${parsed.origin}${parsed.pathname}).`,
    )
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(
      `Unsupported or unsafe video URL protocol "${parsed.protocol}".`,
    )
  }
  return parsed.href
}

/**
 * @param {string} value
 * @param {string} name
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function parseIntRange(value, name, min, max) {
  const trimmed = value.trim()
  if (!/^\d+$/u.test(trimmed)) {
    throw new CliError(`${name} must be an integer, got "${value}"`)
  }
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new CliError(`${name} must be between ${min} and ${max}`)
  }
  return parsed
}

/**
 * @param {string | undefined} value
 * @param {Set<string>} allowed
 * @param {string} name
 * @returns {string | undefined}
 */
function validateChoice(value, allowed, name) {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (!allowed.has(normalized)) {
    throw new CliError(
      `${name} must be one of: ${[...allowed].join(", ")} (got "${value}")`,
    )
  }
  return normalized
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function extractErrorMessage(value) {
  const record = asRecord(value)
  if (typeof record.error === "string" && record.error.trim()) {
    return record.error.trim()
  }
  const nested = asRecord(record.error)
  const message = nested.message ?? record.message ?? record.detail
  return typeof message === "string" && message.trim() ?
      message.trim()
    : undefined
}

/**
 * @param {unknown} value
 * @returns {ParsedVideoStatus}
 */
export function parseVideoStatus(value) {
  const payload = asRecord(value)
  const status = payload.status
  const requestId =
    typeof payload.request_id === "string" && payload.request_id.trim() ?
      payload.request_id.trim()
    : undefined
  const progress =
    typeof payload.progress === "number" && Number.isFinite(payload.progress) ?
      payload.progress
    : undefined
  const model =
    typeof payload.model === "string" && payload.model.trim() ?
      payload.model.trim()
    : undefined

  if (status === "failed" || status === "expired") {
    return {
      status,
      requestId,
      progress,
      model,
      error: extractErrorMessage(payload),
      raw: payload,
    }
  }

  if (status === "done") {
    const video = asRecord(payload.video)
    if (video.respect_moderation === false) {
      return {
        status: "failed",
        requestId,
        progress,
        model,
        error: "The video was filtered by moderation",
        raw: payload,
      }
    }
    if (typeof video.url !== "string" || !video.url.trim()) {
      throw new CliError("Completed video response did not include video.url.")
    }
    return {
      status: "done",
      requestId,
      url: validateMediaUrl(video.url),
      duration: typeof video.duration === "number" ? video.duration : undefined,
      progress,
      model,
      raw: payload,
    }
  }

  if (
    status === "pending"
    || status === "processing"
    || (!status && requestId)
  ) {
    return {
      status: "pending",
      requestId,
      progress,
      model,
      raw: payload,
    }
  }

  throw new CliError(
    extractErrorMessage(payload) ?? "Unexpected video response from gateway.",
  )
}

/**
 * @param {Buffer} bytes
 * @param {string} [fileName]
 * @returns {string}
 */
function detectImageMime(bytes, fileName = "") {
  if (
    bytes.length >= 8
    && bytes[0] === 137
    && bytes[1] === 80
    && bytes[2] === 78
    && bytes[3] === 71
  ) {
    return "image/png"
  }
  if (
    bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
  ) {
    return "image/jpeg"
  }
  if (
    bytes.length >= 12
    && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp"
  }
  const ext = path.extname(fileName).toLowerCase()
  if (ext === ".png") return "image/png"
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".webp") return "image/webp"
  throw new CliError(
    `Unsupported image format for "${fileName || "input"}". Expected PNG, JPEG, or WebP.`,
  )
}

const WARN_VIDEO_IMAGE_BYTES = 1024 * 1024

/**
 * @param {string} raw
 * @param {{ totalBytes: number }} budget
 * @param {(text: string) => void} stderr
 * @returns {Promise<{ url: string, preview: string }>}
 */
async function resolveImageRef(raw, budget, stderr) {
  const trimmed = raw.trim()
  if (/^(?:https?:\/\/|data:image\/[a-z0-9.+-]+;base64,)/iu.test(trimmed)) {
    return {
      url: trimmed,
      preview:
        trimmed.startsWith("data:") ?
          `${trimmed.slice(0, 48)}... (${trimmed.length} chars)`
        : trimmed,
    }
  }
  if (!existsSync(trimmed)) {
    throw new CliError(`Image file not found: ${trimmed}`)
  }
  const info = await stat(trimmed)
  if (!info.isFile()) {
    throw new CliError(`Image path is not a file: ${trimmed}`)
  }
  if (info.size === 0) {
    throw new CliError(`Image file is empty: ${trimmed}`)
  }
  if (info.size > MAX_IMAGE_BYTES) {
    throw new CliError(
      `Image exceeds 20 MiB limit: ${trimmed} (${info.size} bytes)`,
    )
  }
  if (info.size > WARN_VIDEO_IMAGE_BYTES) {
    stderr(
      `Warning: ${trimmed} is ${(info.size / (1024 * 1024)).toFixed(2)} MiB; xAI image-to-video proxies may reject base64 images over 1 MiB. Consider compressing/resizing or passing an https:// URL.\n`,
    )
  }
  budget.totalBytes += info.size
  if (budget.totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new CliError("Total image input size exceeds 40 MiB limit.")
  }
  const bytes = await readFile(trimmed)
  const mime = detectImageMime(bytes, trimmed)
  return {
    url: `data:${mime};base64,${bytes.toString("base64")}`,
    preview: `<file:${trimmed} (${mime}, ${bytes.length} bytes)>`,
  }
}

/**
 * @param {string | undefined} prompt
 * @param {string | undefined} promptFile
 * @returns {Promise<string | undefined>}
 */
async function readOptionalPrompt(prompt, promptFile) {
  if (prompt && promptFile) {
    throw new CliError("Use --prompt or --prompt-file, not both.")
  }
  if (promptFile) {
    if (!existsSync(promptFile)) {
      throw new CliError(`Prompt file not found: ${promptFile}`)
    }
    return (await readFile(promptFile, "utf8")).trim() || undefined
  }
  if (prompt !== undefined) {
    return prompt.trim() || undefined
  }
  return undefined
}

/**
 * @param {Response} response
 * @returns {number | undefined}
 */
function parseRetryAfterMs(response) {
  const header = response.headers.get("retry-after")
  if (!header) return undefined
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 30_000)
  }
  const timestamp = Date.parse(header)
  if (!Number.isNaN(timestamp)) {
    return Math.min(Math.max(0, timestamp - Date.now()), 30_000)
  }
  return undefined
}

/**
 * @param {string | undefined} apiKey
 * @param {string} baseUrl
 * @param {boolean} dryRun
 * @param {(text: string) => void} stderr
 */
function checkAuthEnvironment(apiKey, baseUrl, dryRun, stderr) {
  if (apiKey) return
  if (dryRun) {
    stderr(
      "Warning: GITHUB_COPILOT_API_KEY is not set; dry-run preview only.\n",
    )
    return
  }
  if (!isLoopbackUrl(baseUrl)) {
    throw new CliError(
      `GITHUB_COPILOT_API_KEY is not set for non-loopback gateway ${baseUrl}. Export GITHUB_COPILOT_API_KEY before running.`,
    )
  }
  stderr(
    "Note: GITHUB_COPILOT_API_KEY is not set; sending unauthenticated request to loopback gateway.\n",
  )
}

const POST_RETRYABLE_STATUSES = new Set([429, 503])

/**
 * @param {{
 *   url: string,
 *   method: "GET" | "POST",
 *   apiKey: string | undefined,
 *   body?: string,
 *   timeoutMs: number,
 *   maxAttempts: number,
 *   fetchImpl: FetchLike,
 *   sleep: (ms: number) => Promise<void>,
 *   stderr: (text: string) => void,
 * }} opts
 * @returns {Promise<Record<string, unknown>>}
 */
async function callGatewayJson(opts) {
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/json" }
  if (opts.body !== undefined) headers["Content-Type"] = "application/json"
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`

  // Non-idempotent POST video submissions only retry explicit pre-creation rejections (429/503)
  // to avoid double-billing when a timeout or 502/504 occurs after upstream job acceptance.
  const retryableStatuses =
    opts.method === "POST" ? POST_RETRYABLE_STATUSES : RETRYABLE_STATUSES
  const retryNetworkErrors = opts.method === "GET"

  let lastError
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    try {
      const response = await opts.fetchImpl(opts.url, {
        method: opts.method,
        headers,
        body: opts.body,
        signal: AbortSignal.timeout(opts.timeoutMs),
      })
      const text = await response.text()
      let parsed
      try {
        parsed = text ? JSON.parse(text) : {}
      } catch {
        parsed = { raw: text }
      }
      if (!response.ok) {
        if (
          retryableStatuses.has(response.status)
          && attempt < opts.maxAttempts
        ) {
          const delayMs =
            parseRetryAfterMs(response)
            ?? Math.min(1000 * 2 ** (attempt - 1), 30_000)
          opts.stderr(
            `Gateway returned HTTP ${response.status} (attempt ${attempt}/${opts.maxAttempts}); retrying in ${delayMs}ms...\n`,
          )
          await opts.sleep(delayMs)
          continue
        }
        const detail = extractErrorMessage(parsed) ?? text.slice(0, 400).trim()
        const authHint =
          (response.status === 401 || response.status === 403) && !opts.apiKey ?
            " Set GITHUB_COPILOT_API_KEY to the gateway API key."
          : ""
        throw new CliError(
          `Video API request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}.${authHint}`,
        )
      }
      return asRecord(parsed)
    } catch (error) {
      if (error instanceof CliError) throw error
      lastError = error
      if (retryNetworkErrors && attempt < opts.maxAttempts) {
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 30_000)
        opts.stderr(
          `Network error on attempt ${attempt}/${opts.maxAttempts} (${error instanceof Error ? error.message : String(error)}); retrying in ${delayMs}ms...\n`,
        )
        await opts.sleep(delayMs)
        continue
      }
      const attemptsNote =
        retryNetworkErrors ? ` after ${opts.maxAttempts} attempt(s)` : ""
      throw new CliError(
        `Video API request failed${attemptsNote}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      )
    }
  }
  throw new CliError("Video API request failed unexpectedly.")
}

/**
 * Stream-download the temporary video URL atomically without forwarding
 * gateway credentials to the video CDN host.
 *
 * @param {string} videoUrl
 * @param {string} outPath
 * @param {{
 *   force: boolean,
 *   fetchImpl: typeof fetch,
 *   timeoutMs: number,
 * }} opts
 */
async function downloadVideoAtomic(videoUrl, outPath, opts) {
  const safeUrl = validateMediaUrl(videoUrl)
  if (existsSync(outPath) && !opts.force) {
    throw new CliError(
      `Output already exists: ${outPath} (pass --force to overwrite)`,
    )
  }

  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true })
  const tempPath = `${outPath}.${randomUUID()}.tmp`
  try {
    const response = await opts.fetchImpl(safeUrl, {
      method: "GET",
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
    if (!response.ok || !response.body) {
      throw new CliError(
        `Failed to download video from ${safeUrl} (HTTP ${response.status}).`,
      )
    }
    await pipeline(
      Readable.fromWeb(
        /** @type {Parameters<typeof Readable.fromWeb>[0]} */ (
          /** @type {unknown} */ (response.body)
        ),
      ),
      createWriteStream(tempPath, { flags: "wx" }),
    )
    await rename(tempPath, outPath)
  } finally {
    await rm(tempPath, { force: true })
  }
}

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {string}
 */
export function usageText(env = process.env) {
  const defaultDir = resolveDefaultOutputDir(env)
  return `Usage:
  node video_gen.mjs <generate|submit|status|wait> [options]

Commands:
  generate    Submit video job, poll until done, and download MP4 (default workflow)
  submit      Submit video job and print request_id immediately without polling
  status      Query current status of an existing --request-id once
  wait        Poll an existing --request-id until done and download MP4

Common options:
  --base-url <url>           Gateway root URL (default: $COPILOT_API_BASE_URL or ${DEFAULT_BASE_URL})
  --out <path>               Output MP4 file path (default: unique file in ${defaultDir})
  --force                    Overwrite existing output file
  --no-download              Do not download MP4; report video.url only
  --poll-interval-ms <ms>    Polling interval (default: ${DEFAULT_POLL_INTERVAL_MS})
  --timeout-ms <ms>          Total polling timeout for generate/wait (default: ${DEFAULT_WAIT_TIMEOUT_MS})
  --http-timeout-ms <ms>     Per-request HTTP timeout (default: ${DEFAULT_HTTP_TIMEOUT_MS})
  --max-attempts <1-10>      Retries per call: GET on 429/5xx/network, POST on 429/503 (default: ${DEFAULT_MAX_ATTEMPTS})
  --dry-run                  Print request preview without calling the gateway
  --json                     Emit structured JSON result to stdout
  -h, --help                 Show this help message

Generate / Submit options:
  --model <model>            Video model or mapped alias (default: ${DEFAULT_MODEL})
  --prompt <text>            Video prompt (optional when --image or --last-frame is provided)
  --prompt-file <path>       Read prompt text from UTF-8 file
  --duration <1-15>          Clip duration in seconds (default: xAI default 8s)
  --aspect-ratio <ratio>     16:9 | 9:16 | 1:1 | 4:3 | 3:4 | 3:2 | 2:3 | 21:9 | 5:2
  --resolution <res>         480p | 720p | 1080p
  --audio / --no-audio       Enable or disable generated audio track
  --image <path-or-url>      First-frame image for image-to-video (PNG/JPEG/WebP or URL)
  --last-frame <path-or-url> Optional pinned last frame image (PNG/JPEG/WebP or URL)
  --ref-image <path-or-url>  Reference image for reference-to-video (repeatable, up to ${MAX_REFERENCE_IMAGES})
  --extra-json <json>        Optional JSON object of additional native xAI fields
  --no-wait                  For generate: stop after submit (same as submit)

Status / Wait options:
  --request-id <id>          Video request_id returned by submit/generate
  --download                 For status: download MP4 to --out if status is done

Environment:
  GITHUB_COPILOT_API_KEY     Gateway API key (same key must be used for submit and poll)
  COPILOT_API_BASE_URL       Gateway root URL (default: ${DEFAULT_BASE_URL})
`
}

/**
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    return { help: true, command: "", values: {} }
  }
  const command = argv[0]
  if (
    command !== "generate"
    && command !== "submit"
    && command !== "status"
    && command !== "wait"
  ) {
    throw new CliError(
      `Unknown command "${command}". Expected generate, submit, status, or wait.`,
    )
  }

  let parsed
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      strict: true,
      allowPositionals: false,
      options: {
        help: { type: "boolean", short: "h" },
        "base-url": { type: "string" },
        model: { type: "string" },
        prompt: { type: "string" },
        "prompt-file": { type: "string" },
        duration: { type: "string" },
        "aspect-ratio": { type: "string" },
        resolution: { type: "string" },
        audio: { type: "boolean" },
        "no-audio": { type: "boolean" },
        image: { type: "string" },
        "last-frame": { type: "string" },
        "ref-image": { type: "string", multiple: true },
        "extra-json": { type: "string" },
        "request-id": { type: "string" },
        out: { type: "string" },
        force: { type: "boolean" },
        download: { type: "boolean" },
        "no-download": { type: "boolean" },
        "no-wait": { type: "boolean" },
        "poll-interval-ms": { type: "string" },
        "timeout-ms": { type: "string" },
        "http-timeout-ms": { type: "string" },
        "max-attempts": { type: "string" },
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
      },
    })
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error))
  }

  return {
    help: Boolean(parsed.values.help),
    command,
    values: parsed.values,
  }
}

/**
 * @param {Record<string, unknown>} values
 * @param {(text: string) => void} stderr
 * @returns {Promise<{ payload: Record<string, unknown>, previewPayload: Record<string, unknown> }>}
 */
async function buildGenerationPayload(values, stderr) {
  if (values.audio && values["no-audio"]) {
    throw new CliError("Do not pass both --audio and --no-audio.")
  }

  const model =
    typeof values.model === "string" && values.model.trim() ?
      values.model.trim()
    : DEFAULT_MODEL

  const prompt = await readOptionalPrompt(
    /** @type {string | undefined} */ (values.prompt),
    /** @type {string | undefined} */ (values["prompt-file"]),
  )
  const imageArg =
    typeof values.image === "string" && values.image.trim() ?
      values.image.trim()
    : undefined
  const lastFrameArg =
    typeof values["last-frame"] === "string" && values["last-frame"].trim() ?
      values["last-frame"].trim()
    : undefined
  const refImageArgs = /** @type {string[] | undefined} */ (
    values["ref-image"] ?? []
  )
    .map((item) => item.trim())
    .filter(Boolean)

  if (!prompt && !imageArg && !lastFrameArg) {
    throw new CliError(
      "A --prompt (or --prompt-file), --image, or --last-frame is required.",
    )
  }
  if (refImageArgs.length > MAX_REFERENCE_IMAGES) {
    throw new CliError(
      `At most ${MAX_REFERENCE_IMAGES} --ref-image inputs are supported.`,
    )
  }

  const duration =
    values.duration !== undefined ?
      parseIntRange(String(values.duration), "--duration", 1, 15)
    : undefined
  const aspectRatio = validateChoice(
    /** @type {string | undefined} */ (values["aspect-ratio"]),
    VIDEO_RATIOS,
    "--aspect-ratio",
  )
  const resolution = validateChoice(
    /** @type {string | undefined} */ (values.resolution),
    VIDEO_RESOLUTIONS,
    "--resolution",
  )

  if (resolution === "1080p" && refImageArgs.length > 0) {
    stderr(
      "Warning: xAI reference-to-video supports up to 720p; consider --resolution 720p when using --ref-image.\n",
    )
  }

  /** @type {Record<string, unknown>} */
  let extraFields = {}
  if (typeof values["extra-json"] === "string" && values["extra-json"].trim()) {
    let parsed
    try {
      parsed = JSON.parse(values["extra-json"])
    } catch (error) {
      throw new CliError(
        `Invalid --extra-json: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (
      parsed === null
      || typeof parsed !== "object"
      || Array.isArray(parsed)
    ) {
      throw new CliError("--extra-json must be a JSON object.")
    }
    extraFields = /** @type {Record<string, unknown>} */ (parsed)
  }

  const budget = { totalBytes: 0 }
  const firstFrame =
    imageArg ? await resolveImageRef(imageArg, budget, stderr) : undefined
  const lastFrame =
    lastFrameArg ?
      await resolveImageRef(lastFrameArg, budget, stderr)
    : undefined
  const refImages = []
  for (const ref of refImageArgs) {
    refImages.push(await resolveImageRef(ref, budget, stderr))
  }

  const baseFields = {
    ...extraFields,
    model,
    ...(prompt ? { prompt } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(resolution ? { resolution } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(values.audio ? { generate_audio: true } : {}),
    ...(values["no-audio"] ? { generate_audio: false } : {}),
  }

  /** @type {Record<string, unknown>} */
  const payload = {
    ...baseFields,
    ...(firstFrame ? { image: { url: firstFrame.url } } : {}),
    ...(lastFrame ? { last_frame: { url: lastFrame.url } } : {}),
    ...(refImages.length > 0 ?
      { reference_images: refImages.map((item) => ({ url: item.url })) }
    : {}),
  }

  /** @type {Record<string, unknown>} */
  const previewPayload = {
    ...baseFields,
    ...(firstFrame ? { image: { url: firstFrame.preview } } : {}),
    ...(lastFrame ? { last_frame: { url: lastFrame.preview } } : {}),
    ...(refImages.length > 0 ?
      { reference_images: refImages.map((item) => ({ url: item.preview })) }
    : {}),
  }

  return { payload, previewPayload }
}

/**
 * @param {{
 *   baseUrl: string,
 *   requestId: string,
 *   apiKey: string | undefined,
 *   pollIntervalMs: number,
 *   waitTimeoutMs: number,
 *   httpTimeoutMs: number,
 *   maxAttempts: number,
 *   outPath: string,
 *   fetchImpl: typeof fetch,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   stderr: (text: string) => void,
 * }} opts
 * @returns {Promise<ParsedVideoStatus>}
 */
async function pollUntilTerminal(opts) {
  const statusUrl = `${opts.baseUrl}/v1/videos/${encodeURIComponent(opts.requestId)}`
  const deadline = opts.now() + opts.waitTimeoutMs
  let attempt = 0

  while (true) {
    attempt += 1
    const body = await callGatewayJson({
      url: statusUrl,
      method: "GET",
      apiKey: opts.apiKey,
      timeoutMs: opts.httpTimeoutMs,
      maxAttempts: opts.maxAttempts,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      stderr: opts.stderr,
    })
    const parsed = parseVideoStatus(body)
    if (parsed.status !== "pending") {
      return { ...parsed, requestId: parsed.requestId ?? opts.requestId }
    }

    const progressNote =
      parsed.progress !== undefined ? ` (${parsed.progress}%)` : ""
    opts.stderr(
      `Poll #${attempt}: request_id=${opts.requestId} status=pending${progressNote}\n`,
    )

    if (opts.now() >= deadline) {
      const formattedOut =
        /\s/u.test(opts.outPath) ? JSON.stringify(opts.outPath) : opts.outPath
      throw new CliError(
        `Timed out waiting for video request_id=${opts.requestId} after ${opts.waitTimeoutMs}ms. Resume without resubmitting via: node video_gen.mjs wait --request-id ${opts.requestId} --out ${formattedOut}`,
      )
    }

    const remaining = Math.max(0, deadline - opts.now())
    await opts.sleep(Math.min(opts.pollIntervalMs, remaining))
  }
}

/**
 * @param {string[]} argv
 * @param {CliDeps} [deps={}]
 * @returns {Promise<VideoGenRunResult | null>}
 */
export async function runVideoGen(argv, deps = {}) {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const stdout = deps.stdout ?? ((text) => process.stdout.write(text))
  const stderr = deps.stderr ?? ((text) => process.stderr.write(text))
  const sleep =
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now

  const parsed = parseCliArgs(argv)
  if (parsed.help) {
    stdout(usageText(env))
    return null
  }

  const command = /** @type {"generate" | "submit" | "status" | "wait"} */ (
    parsed.command
  )
  const { values } = parsed
  const dryRun = Boolean(values["dry-run"])
  const force = Boolean(values.force)
  const jsonOutput = Boolean(values.json)
  const noDownload = Boolean(values["no-download"])
  const noWait = Boolean(values["no-wait"])

  const baseUrl = normalizeBaseUrl(
    /** @type {string | undefined} */ (values["base-url"])
      ?? env.COPILOT_API_BASE_URL,
  )
  const apiKey = (env.GITHUB_COPILOT_API_KEY ?? "").trim() || undefined
  const outPath =
    typeof values.out === "string" && values.out.trim() ?
      values.out.trim()
    : buildDefaultOutputPath(env)
  const pollIntervalMs =
    values["poll-interval-ms"] !== undefined ?
      parseIntRange(
        String(values["poll-interval-ms"]),
        "--poll-interval-ms",
        10,
        120_000,
      )
    : DEFAULT_POLL_INTERVAL_MS
  const waitTimeoutMs =
    values["timeout-ms"] !== undefined ?
      parseIntRange(
        String(values["timeout-ms"]),
        "--timeout-ms",
        100,
        3_600_000,
      )
    : DEFAULT_WAIT_TIMEOUT_MS
  const httpTimeoutMs =
    values["http-timeout-ms"] !== undefined ?
      parseIntRange(
        String(values["http-timeout-ms"]),
        "--http-timeout-ms",
        1000,
        600_000,
      )
    : DEFAULT_HTTP_TIMEOUT_MS
  const maxAttempts =
    values["max-attempts"] !== undefined ?
      parseIntRange(String(values["max-attempts"]), "--max-attempts", 1, 10)
    : DEFAULT_MAX_ATTEMPTS

  if (values.download && noDownload) {
    throw new CliError("Do not pass both --download and --no-download.")
  }

  if (command === "status" || command === "wait") {
    if (
      typeof values["request-id"] !== "string"
      || !values["request-id"].trim()
    ) {
      throw new CliError(`${command} requires --request-id <id>.`)
    }
    const requestId = validateRequestId(values["request-id"])
    const endpoint = `${baseUrl}/v1/videos/${encodeURIComponent(requestId)}`
    const wantsDownload =
      command === "wait" ? !noDownload : Boolean(values.download)
    checkAuthEnvironment(apiKey, baseUrl, dryRun, stderr)

    if (dryRun) {
      stdout(
        `${JSON.stringify(
          {
            dry_run: true,
            command,
            endpoint,
            method: "GET",
            auth:
              apiKey ?
                "Bearer [REDACTED] (from GITHUB_COPILOT_API_KEY)"
              : "none (GITHUB_COPILOT_API_KEY unset)",
            request_id: requestId,
            ...(wantsDownload ? { out: outPath } : {}),
          },
          null,
          2,
        )}\n`,
      )
      return { command, endpoint, dryRun: true, requestId }
    }

    if (wantsDownload && existsSync(outPath) && !force) {
      throw new CliError(
        `Output already exists: ${outPath} (pass --force to overwrite)`,
      )
    }

    const result =
      command === "status" ?
        parseVideoStatus(
          await callGatewayJson({
            url: endpoint,
            method: "GET",
            apiKey,
            timeoutMs: httpTimeoutMs,
            maxAttempts,
            fetchImpl,
            sleep,
            stderr,
          }),
        )
      : await pollUntilTerminal({
          baseUrl,
          requestId,
          apiKey,
          pollIntervalMs,
          waitTimeoutMs,
          httpTimeoutMs,
          maxAttempts,
          outPath,
          fetchImpl,
          sleep,
          now,
          stderr,
        })

    if (result.status === "failed" || result.status === "expired") {
      if (jsonOutput) {
        stdout(
          `${JSON.stringify(
            {
              command,
              endpoint,
              request_id: requestId,
              status: result.status,
              error: result.error,
              response: result.raw,
            },
            null,
            2,
          )}\n`,
        )
      }
      throw new CliError(
        `Video job ${requestId} ${result.status}${result.error ? `: ${result.error}` : ""}.`,
      )
    }

    let savedPath
    const shouldDownload =
      result.status === "done"
      && Boolean(result.url)
      && (command === "wait" ? !noDownload : Boolean(values.download))

    if (shouldDownload && result.url) {
      await downloadVideoAtomic(result.url, outPath, {
        force,
        fetchImpl,
        timeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_MS,
      })
      savedPath = outPath
    }

    if (jsonOutput) {
      stdout(
        `${JSON.stringify(
          {
            command,
            endpoint,
            request_id: requestId,
            status: result.status,
            ...(result.url ? { video_url: result.url } : {}),
            ...(result.duration !== undefined ?
              { duration: result.duration }
            : {}),
            ...(savedPath ? { out: savedPath } : {}),
            response: result.raw,
          },
          null,
          2,
        )}\n`,
      )
    } else {
      stdout(`Request ID: ${requestId}\nStatus: ${result.status}\n`)
      if (result.url) stdout(`Video URL: ${result.url}\n`)
      if (savedPath) stdout(`Wrote ${savedPath}\n`)
    }

    return {
      command,
      endpoint,
      dryRun: false,
      requestId,
      status: result.status,
      videoUrl: result.url,
      outPath: savedPath,
      raw: result.raw,
    }
  }

  // generate or submit
  const endpoint = `${baseUrl}/v1/videos/generations`
  const { payload, previewPayload } = await buildGenerationPayload(
    values,
    stderr,
  )
  checkAuthEnvironment(apiKey, baseUrl, dryRun, stderr)

  if (dryRun) {
    stdout(
      `${JSON.stringify(
        {
          dry_run: true,
          command,
          endpoint,
          method: "POST",
          auth:
            apiKey ?
              "Bearer [REDACTED] (from GITHUB_COPILOT_API_KEY)"
            : "none (GITHUB_COPILOT_API_KEY unset)",
          ...(command === "generate" && !noWait && !noDownload ?
            { out: outPath }
          : {}),
          payload: previewPayload,
        },
        null,
        2,
      )}\n`,
    )
    return {
      command,
      endpoint,
      dryRun: true,
      outPath:
        command === "generate" && !noWait && !noDownload ? outPath : undefined,
    }
  }

  // Fail before submitting a paid job if destination already exists and --force wasn't set.
  if (
    command === "generate"
    && !noWait
    && !noDownload
    && existsSync(outPath)
    && !force
  ) {
    throw new CliError(
      `Output already exists: ${outPath} (pass --force to overwrite)`,
    )
  }

  stderr(`Submitting video generation to ${endpoint}...\n`)
  const submitRaw = await callGatewayJson({
    url: endpoint,
    method: "POST",
    apiKey,
    body: JSON.stringify(payload),
    timeoutMs: httpTimeoutMs,
    maxAttempts,
    fetchImpl,
    sleep,
    stderr,
  })
  const initial = parseVideoStatus(submitRaw)
  const requestId = initial.requestId
  if (requestId) {
    stderr(`Submitted video job: request_id=${requestId}\n`)
  }

  if (command === "submit" || noWait) {
    if (!requestId && initial.status === "pending") {
      throw new CliError("Gateway did not return a request_id for video job.")
    }
    if (jsonOutput) {
      stdout(
        `${JSON.stringify(
          {
            command,
            endpoint,
            request_id: requestId,
            status: initial.status,
            ...(initial.url ? { video_url: initial.url } : {}),
            response: submitRaw,
          },
          null,
          2,
        )}\n`,
      )
    } else {
      if (requestId) stdout(`Request ID: ${requestId}\n`)
      stdout(`Status: ${initial.status}\n`)
      if (initial.url) stdout(`Video URL: ${initial.url}\n`)
    }
    return {
      command,
      endpoint,
      dryRun: false,
      requestId,
      status: initial.status,
      videoUrl: initial.url,
      raw: submitRaw,
    }
  }

  let finalStatus = initial
  if (finalStatus.status === "pending") {
    if (!requestId) {
      throw new CliError("Gateway did not return a request_id to poll.")
    }
    finalStatus = await pollUntilTerminal({
      baseUrl,
      requestId,
      apiKey,
      pollIntervalMs,
      waitTimeoutMs,
      httpTimeoutMs,
      maxAttempts,
      outPath,
      fetchImpl,
      sleep,
      now,
      stderr,
    })
  }

  if (finalStatus.status === "failed" || finalStatus.status === "expired") {
    if (jsonOutput) {
      stdout(
        `${JSON.stringify(
          {
            command,
            endpoint,
            request_id: requestId,
            status: finalStatus.status,
            error: finalStatus.error,
            response: finalStatus.raw,
          },
          null,
          2,
        )}\n`,
      )
    }
    throw new CliError(
      `Video generation ${requestId ?? ""} ${finalStatus.status}${finalStatus.error ? `: ${finalStatus.error}` : ""}.`,
    )
  }

  let savedPath
  if (!noDownload && finalStatus.url) {
    stderr(`Downloading completed video to ${outPath}...\n`)
    await downloadVideoAtomic(finalStatus.url, outPath, {
      force,
      fetchImpl,
      timeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_MS,
    })
    savedPath = outPath
  }

  if (jsonOutput) {
    stdout(
      `${JSON.stringify(
        {
          command,
          endpoint,
          request_id: requestId,
          status: finalStatus.status,
          ...(finalStatus.url ? { video_url: finalStatus.url } : {}),
          ...(finalStatus.duration !== undefined ?
            { duration: finalStatus.duration }
          : {}),
          ...(savedPath ? { out: savedPath } : {}),
          response: finalStatus.raw,
        },
        null,
        2,
      )}\n`,
    )
  } else {
    if (requestId) stdout(`Request ID: ${requestId}\n`)
    stdout(`Status: ${finalStatus.status}\n`)
    if (finalStatus.url) stdout(`Video URL: ${finalStatus.url}\n`)
    if (savedPath) stdout(`Wrote ${savedPath}\n`)
  }

  return {
    command,
    endpoint,
    dryRun: false,
    requestId,
    status: finalStatus.status,
    videoUrl: finalStatus.url,
    outPath: savedPath,
    raw: finalStatus.raw,
  }
}

/**
 * @returns {boolean}
 */
function isDirectExecution() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
  } catch {
    return false
  }
}

if (isDirectExecution()) {
  runVideoGen(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Error: ${message}\n`)
    process.exitCode = error instanceof CliError ? error.exitCode : 1
  })
}
