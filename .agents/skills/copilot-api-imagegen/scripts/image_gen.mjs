#!/usr/bin/env node
/**
 * CLI for image generation, image editing, and concurrent batch generation
 * through a running copilot-api gateway (/v1/images/generations,
 * /v1/images/edits, and /:provider/v1/images/*).
 *
 * Uses zero third-party dependencies (Node.js 20+ or Bun).
 * Authentication uses GITHUB_COPILOT_API_KEY and gateway URL uses
 * COPILOT_API_BASE_URL (default: http://localhost:4141).
 */

import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { machine, release, tmpdir, type as osType } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

export const DEFAULT_BASE_URL = "http://localhost:4141"
export const DEFAULT_MODEL = "gpt-image-2"
export const DEFAULT_SIZE = "auto"
export const DEFAULT_QUALITY = "medium"
export const DEFAULT_OUTPUT_FORMAT = "png"
export const DEFAULT_OUTPUT_SUBDIR = "copilot-api-imagegen"
export const DEFAULT_CONCURRENCY = 5
export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
export const CODEX_CLI_VERSION = "0.166.0"

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
 * @param {string} [outputFormat=DEFAULT_OUTPUT_FORMAT]
 * @param {Record<string, string | undefined>} [env=process.env]
 * @param {string} [prefix="image"]
 * @returns {string}
 */
export function buildDefaultOutputPath(
  outputFormat = DEFAULT_OUTPUT_FORMAT,
  env = process.env,
  prefix = "image",
) {
  const fileName = `${prefix}-${formatTimestampSlug()}-${randomUUID().slice(0, 8)}.${outputFormat}`
  return path.join(resolveDefaultOutputDir(env), fileName)
}

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {string}
 */
export function buildDefaultBatchOutputDir(env = process.env) {
  const dirName = `batch-${formatTimestampSlug()}-${randomUUID().slice(0, 8)}`
  return path.join(resolveDefaultOutputDir(env), dirName)
}

const GPT_IMAGE_2_MODEL = "gpt-image-2"
const GPT_IMAGE_2_MIN_PIXELS = 655_360
const GPT_IMAGE_2_MAX_PIXELS = 8_294_400
const GPT_IMAGE_2_MAX_EDGE = 3840
const GPT_IMAGE_2_MAX_RATIO = 3.0

const LEGACY_GPT_IMAGE_MODELS = new Set([
  "gpt-image-1.5",
  "gpt-image-1",
  "gpt-image-1-mini",
])
const ALLOWED_LEGACY_SIZES = new Set([
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "auto",
])
const ALLOWED_QUALITIES = new Set(["low", "medium", "high", "auto"])
const ALLOWED_BACKGROUNDS = new Set(["transparent", "opaque", "auto"])
const ALLOWED_OUTPUT_FORMATS = new Set(["png", "jpeg", "jpg", "webp", "gif"])
const ALLOWED_INPUT_FIDELITIES = new Set(["low", "high"])
const ALLOWED_MODERATIONS = new Set(["auto", "low"])
const ALLOWED_TRANSPORTS = new Set(["multipart", "json"])
const ALLOWED_XAI_RESOLUTIONS = new Set(["1k", "2k"])
const ALLOWED_XAI_ASPECT_RATIOS = new Set([
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
  "auto",
])
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])

const MAX_EDIT_FILES = 16
const MAX_XAI_EDIT_FILES = 5
const WARN_IMAGE_BYTES = 50 * 1024 * 1024
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_UPLOAD_BYTES = 128 * 1024 * 1024
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const MAX_BATCH_JOBS = 500

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
 * }} CliDeps
 */

/**
 * @typedef {{
 *   command: "generate" | "edit" | "generate-batch",
 *   endpoint: string,
 *   dryRun: boolean,
 *   outputs: string[],
 *   revisedPrompts?: string[],
 *   failedJobs?: number,
 *   totalJobs?: number,
 * }} ImageGenRunResult
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
 * @param {string | undefined} provider
 * @returns {string | undefined}
 */
function validateProvider(provider) {
  if (provider === undefined) return undefined
  const trimmed = provider.trim()
  if (
    !trimmed
    || trimmed === "."
    || trimmed === ".."
    || /[/\\?#@]/u.test(trimmed)
  ) {
    throw new CliError(
      `Invalid --provider value: ${JSON.stringify(provider)}. Must be a single path segment.`,
    )
  }
  return trimmed
}

/**
 * @param {string} baseUrl
 * @param {"generations" | "edits"} operation
 * @param {string | undefined} provider
 * @returns {string}
 */
export function buildEndpointUrl(baseUrl, operation, provider) {
  if (provider) {
    return `${baseUrl}/${encodeURIComponent(provider)}/v1/images/${operation}`
  }
  return `${baseUrl}/v1/images/${operation}`
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
 * @param {string | undefined} fmt
 * @returns {string}
 */
export function normalizeOutputFormat(fmt) {
  if (!fmt) return DEFAULT_OUTPUT_FORMAT
  const normalized = validateChoice(
    fmt,
    ALLOWED_OUTPUT_FORMATS,
    "--output-format",
  )
  return normalized === "jpg" ? "jpeg" : (normalized ?? DEFAULT_OUTPUT_FORMAT)
}

/**
 * @param {string | undefined} model
 * @returns {{ provider?: string, bareModel?: string }}
 */
function splitModelAlias(model) {
  if (!model) return {}
  const trimmed = model.trim()
  if (!trimmed) return {}
  const slashIndex = trimmed.indexOf("/")
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    return {
      provider: trimmed.slice(0, slashIndex).toLowerCase(),
      bareModel: trimmed.slice(slashIndex + 1),
    }
  }
  return { bareModel: trimmed }
}

/**
 * @param {string | undefined} model
 * @param {string | undefined} provider
 * @returns {boolean}
 */
function isExplicitXaiTarget(model, provider) {
  if (provider?.toLowerCase() === "xai") return true
  const { provider: aliasProvider, bareModel } = splitModelAlias(model)
  return (
    aliasProvider === "xai"
    || Boolean(bareModel?.startsWith("grok-imagine-image"))
  )
}

/**
 * @param {string | undefined} model
 * @param {string | undefined} provider
 * @returns {boolean}
 */
function isExplicitCopilotFlare(model, provider) {
  const { provider: aliasProvider, bareModel } = splitModelAlias(model)
  if (bareModel?.startsWith("gpt-image-2.5-flare")) return true
  return (
    (provider?.toLowerCase() === "github-copilot"
      || aliasProvider === "github-copilot")
    && (!bareModel || bareModel === "gpt-image-2.5-flare")
  )
}

/**
 * @param {string} size
 */
export function validateGptImage2Size(size) {
  if (size === "auto") return
  const match = /^([1-9]\d*)x([1-9]\d*)$/u.exec(size)
  if (!match) {
    throw new CliError(
      `size must be "auto" or WIDTHxHEIGHT (e.g. 1024x1024), got "${size}".`,
    )
  }
  const width = Number.parseInt(match[1], 10)
  const height = Number.parseInt(match[2], 10)
  const maxEdge = Math.max(width, height)
  const minEdge = Math.min(width, height)
  const totalPixels = width * height

  if (maxEdge > GPT_IMAGE_2_MAX_EDGE) {
    throw new CliError(
      "gpt-image-2 size maximum edge length must be <= 3840px.",
    )
  }
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new CliError(
      "gpt-image-2 size width and height must be multiples of 16px.",
    )
  }
  if (maxEdge / minEdge > GPT_IMAGE_2_MAX_RATIO) {
    throw new CliError(
      "gpt-image-2 size long edge to short edge ratio must not exceed 3:1.",
    )
  }
  if (
    totalPixels < GPT_IMAGE_2_MIN_PIXELS
    || totalPixels > GPT_IMAGE_2_MAX_PIXELS
  ) {
    throw new CliError(
      "gpt-image-2 size total pixels must be between 655,360 and 8,294,400.",
    )
  }
}

/**
 * @param {{
 *   operation: "generations" | "edits",
 *   model: string | undefined,
 *   provider: string | undefined,
 *   size: string | undefined,
 *   quality: string | undefined,
 *   background: string | undefined,
 *   outputFormat: string,
 *   outputCompression: number | undefined,
 *   inputFidelity: string | undefined,
 *   moderation: string | undefined,
 *   frameCount: number | undefined,
 *   frameDurationMs: number | undefined,
 *   aspectRatio: string | undefined,
 *   resolution: string | undefined,
 *   imageCount?: number,
 *   hasMask?: boolean,
 * }} opts
 */
export function validateImageOptions(opts) {
  const { provider: aliasProvider, bareModel } = splitModelAlias(opts.model)
  const effectiveProvider = opts.provider?.toLowerCase() ?? aliasProvider
  const isGptImage2 =
    bareModel === GPT_IMAGE_2_MODEL
    && (!effectiveProvider || effectiveProvider === "codex")
  const isLegacyGptImage =
    bareModel !== undefined
    && LEGACY_GPT_IMAGE_MODELS.has(bareModel)
    && (!effectiveProvider || effectiveProvider === "codex")

  if (opts.size !== undefined) {
    if (isGptImage2) {
      validateGptImage2Size(opts.size)
    } else if (isLegacyGptImage) {
      if (!ALLOWED_LEGACY_SIZES.has(opts.size)) {
        throw new CliError(
          `size must be one of 1024x1024, 1536x1024, 1024x1536, or auto for ${bareModel}.`,
        )
      }
    } else if (
      opts.size !== "auto"
      && !/^([1-9]\d*)x([1-9]\d*)$/u.test(opts.size)
    ) {
      throw new CliError(
        `size must be "auto" or WIDTHxHEIGHT, got "${opts.size}".`,
      )
    }
  }

  if (opts.quality !== undefined) {
    validateChoice(opts.quality, ALLOWED_QUALITIES, "--quality")
  }
  if (opts.background !== undefined) {
    validateChoice(opts.background, ALLOWED_BACKGROUNDS, "--background")
  }
  if (opts.inputFidelity !== undefined) {
    validateChoice(
      opts.inputFidelity,
      ALLOWED_INPUT_FIDELITIES,
      "--input-fidelity",
    )
  }
  if (opts.moderation !== undefined) {
    validateChoice(opts.moderation, ALLOWED_MODERATIONS, "--moderation")
  }
  if (opts.aspectRatio !== undefined) {
    validateChoice(
      opts.aspectRatio,
      ALLOWED_XAI_ASPECT_RATIOS,
      "--aspect-ratio",
    )
  }
  if (opts.resolution !== undefined) {
    validateChoice(opts.resolution, ALLOWED_XAI_RESOLUTIONS, "--resolution")
  }

  if (
    opts.background === "transparent"
    && opts.outputFormat !== "png"
    && opts.outputFormat !== "webp"
  ) {
    throw new CliError(
      "transparent background requires --output-format png or webp.",
    )
  }

  if (
    opts.outputCompression !== undefined
    && opts.outputFormat !== "jpeg"
    && opts.outputFormat !== "webp"
  ) {
    throw new CliError(
      "--output-compression is only supported for jpeg or webp output.",
    )
  }

  if (isGptImage2) {
    if (opts.background === "transparent") {
      throw new CliError(
        "background=transparent is not supported by gpt-image-2. Use --model gpt-image-1.5 --background transparent --output-format png (or codex/gpt-image-1.5) instead.",
      )
    }
    if (opts.inputFidelity !== undefined) {
      throw new CliError(
        "input_fidelity is not supported by gpt-image-2 because image inputs always use high fidelity.",
      )
    }
  }

  if (opts.outputFormat === "gif") {
    if (opts.operation !== "generations") {
      throw new CliError("GIF output is only supported for generate, not edit.")
    }
    if (isExplicitXaiTarget(opts.model, opts.provider)) {
      throw new CliError("xAI image generation does not support GIF output.")
    }
    if (isExplicitCopilotFlare(opts.model, opts.provider)) {
      throw new CliError("GPT Image 2.5 Flare does not support GIF output.")
    }
  } else if (
    opts.frameCount !== undefined
    || opts.frameDurationMs !== undefined
  ) {
    throw new CliError(
      "--frame-count and --frame-duration-ms require --output-format gif.",
    )
  }

  if (opts.operation === "edits") {
    if (isExplicitXaiTarget(opts.model, opts.provider)) {
      if ((opts.imageCount ?? 0) > MAX_XAI_EDIT_FILES) {
        throw new CliError(
          `xAI image edits accept at most ${MAX_XAI_EDIT_FILES} input images.`,
        )
      }
      if (opts.hasMask) {
        throw new CliError("xAI image edits do not support --mask.")
      }
    }
    if ((opts.imageCount ?? 0) > MAX_EDIT_FILES) {
      throw new CliError(
        `At most ${MAX_EDIT_FILES} input images are supported per edit request.`,
      )
    }
  }
}

/**
 * @param {boolean} augment
 * @param {string} prompt
 * @param {Record<string, string | undefined>} fields
 * @returns {string}
 */
export function buildAugmentedPrompt(augment, prompt, fields) {
  if (!augment) return prompt
  const labeled = [
    ["Use case", fields.use_case],
    ["Scene/backdrop", fields.scene],
    ["Subject", fields.subject],
    ["Style/medium", fields.style],
    ["Composition/framing", fields.composition],
    ["Lighting/mood", fields.lighting],
    ["Color palette", fields.palette],
    ["Materials/textures", fields.materials],
    ["Text (verbatim)", fields.text],
    ["Constraints", fields.constraints],
    ["Avoid", fields.negative],
  ].filter(([, value]) => typeof value === "string" && value.trim().length > 0)

  if (labeled.length === 0) return prompt

  const lines = []
  if (fields.use_case?.trim()) {
    lines.push(`Use case: ${fields.use_case.trim()}`)
  }
  lines.push(`Primary request: ${prompt}`)
  for (const [label, value] of labeled) {
    if (label === "Use case") continue
    lines.push(`${label}: ${value?.trim()}`)
  }
  return lines.join("\n")
}

/**
 * @param {Buffer} bytes
 * @param {string} [fileName]
 * @returns {string}
 */
export function detectImageMime(bytes, fileName = "") {
  if (
    bytes.length >= 8
    && bytes[0] === 137
    && bytes[1] === 80
    && bytes[2] === 78
    && bytes[3] === 71
    && bytes[4] === 13
    && bytes[5] === 10
    && bytes[6] === 26
    && bytes[7] === 10
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
  if (bytes.length >= 6 && /^GIF8[79]a/u.test(bytes.toString("ascii", 0, 6))) {
    return "image/gif"
  }
  const ext = path.extname(fileName).toLowerCase()
  if (ext === ".png") return "image/png"
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".webp") return "image/webp"
  if (ext === ".gif") return "image/gif"
  throw new CliError(
    `Could not determine supported image MIME type (png/jpeg/webp/gif) for "${fileName || "input"}".`,
  )
}

/**
 * @param {string} mime
 * @returns {string}
 */
function extensionForMime(mime) {
  if (mime === "image/jpeg") return "jpeg"
  if (mime === "image/webp") return "webp"
  if (mime === "image/gif") return "gif"
  return "png"
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
function isRemoteOrDataImageUrl(raw) {
  return /^(?:https?:\/\/|data:image\/[a-z0-9.+-]+;base64,)/iu.test(raw.trim())
}

/**
 * @param {string} out
 * @param {string} outputFormat
 * @param {number} count
 * @param {string | undefined} outDir
 * @param {(text: string) => void} stderr
 * @returns {string[]}
 */
export function buildOutputPaths(out, outputFormat, count, outDir, stderr) {
  const ext = `.${outputFormat}`
  if (outDir) {
    return Array.from({ length: count }, (_, idx) =>
      path.join(outDir, `image_${idx + 1}${ext}`),
    )
  }

  let base = out
  const parsed = path.parse(base)
  if (!parsed.ext) {
    base = `${base}${ext}`
  } else {
    const normalizedExt = parsed.ext.slice(1).toLowerCase()
    const expectedExt =
      outputFormat === "jpeg" ? ["jpeg", "jpg"] : [outputFormat]
    if (!expectedExt.includes(normalizedExt)) {
      stderr(
        `Warning: Output extension ${parsed.ext} does not match output-format ${outputFormat}.\n`,
      )
    }
  }

  if (count === 1) return [base]

  const finalParsed = path.parse(base)
  return Array.from({ length: count }, (_, idx) =>
    path.join(
      finalParsed.dir,
      `${finalParsed.name}-${idx + 1}${finalParsed.ext}`,
    ),
  )
}

/**
 * @param {string} value
 * @returns {string}
 */
function slugify(value) {
  const slug = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/-{2,}/gu, "-")
    .replace(/^-|-$/gu, "")
  return slug.slice(0, 60) || "job"
}

/**
 * @param {{
 *   outDir: string,
 *   outputFormat: string,
 *   index: number,
 *   prompt: string,
 *   n: number,
 *   explicitOut?: string,
 *   stderr: (text: string) => void,
 * }} opts
 * @returns {string[]}
 */
function buildBatchJobOutputPaths(opts) {
  const ext = `.${opts.outputFormat}`
  let fileName
  if (opts.explicitOut) {
    const trimmed = opts.explicitOut.trim()
    if (
      !trimmed
      || trimmed.includes("/")
      || trimmed.includes("\\")
      || trimmed === "."
      || trimmed === ".."
    ) {
      throw new CliError(
        `Job ${opts.index}: "out" must be a plain filename inside --out-dir (got ${JSON.stringify(opts.explicitOut)}).`,
      )
    }
    const parsed = path.parse(trimmed)
    if (!parsed.ext) {
      fileName = `${trimmed}${ext}`
    } else {
      const normalizedExt = parsed.ext.slice(1).toLowerCase()
      const expected =
        opts.outputFormat === "jpeg" ? ["jpeg", "jpg"] : [opts.outputFormat]
      if (!expected.includes(normalizedExt)) {
        opts.stderr(
          `Warning: Job ${opts.index}: output extension ${parsed.ext} does not match output-format ${opts.outputFormat}.\n`,
        )
      }
      fileName = trimmed
    }
  } else {
    fileName = `${String(opts.index).padStart(3, "0")}-${slugify(opts.prompt.slice(0, 80))}${ext}`
  }

  const basePath = path.join(opts.outDir, fileName)
  if (opts.n === 1) return [basePath]
  const parsed = path.parse(basePath)
  return Array.from({ length: opts.n }, (_, idx) =>
    path.join(parsed.dir, `${parsed.name}-${idx + 1}${parsed.ext}`),
  )
}

/**
 * @param {string[]} outputPaths
 * @param {boolean} force
 */
function assertOutputsWritable(outputPaths, force) {
  if (force) return
  for (const outPath of outputPaths) {
    if (existsSync(outPath)) {
      throw new CliError(
        `Output already exists: ${outPath} (pass --force to overwrite)`,
      )
    }
  }
}

/**
 * @param {string} filePath
 * @param {Buffer} bytes
 * @param {boolean} force
 */
async function writeBytesAtomic(filePath, bytes, force) {
  if (existsSync(filePath) && !force) {
    throw new CliError(
      `Output already exists: ${filePath} (pass --force to overwrite)`,
    )
  }
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true })
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, bytes, { flag: "wx" })
    await rename(tempPath, filePath)
  } finally {
    await rm(tempPath, { force: true })
  }
}

/**
 * @param {string} url
 * @param {FetchLike} fetchImpl
 * @param {number} timeoutMs
 * @returns {Promise<Buffer>}
 */
async function downloadRemoteImage(url, fetchImpl, timeoutMs) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new CliError("Invalid image URL in response.")
  }
  if (parsed.username || parsed.password) {
    throw new CliError(
      `Refusing to download unsafe image URL with embedded credentials (${parsed.origin}${parsed.pathname}).`,
    )
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(
      `Refusing to download unsafe image URL protocol "${parsed.protocol}".`,
    )
  }

  // Never forward GITHUB_COPILOT_API_KEY to external image CDNs.
  const response = await fetchImpl(parsed.href, {
    method: "GET",
    signal: AbortSignal.timeout(Math.min(timeoutMs, 5 * 60 * 1000)),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new CliError(
      `Failed to download generated image from URL (HTTP ${response.status}).`,
    )
  }
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new CliError(
      `Downloaded image exceeds ${MAX_DOWNLOAD_BYTES} byte limit.`,
    )
  }
  if (!response.body) {
    throw new CliError("Downloaded image body was empty.")
  }

  const reader = response.body.getReader()
  /** @type {Uint8Array[]} */
  const chunks = []
  let totalBytes = 0
  let finished = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        finished = true
        break
      }
      totalBytes += value.byteLength
      if (totalBytes > MAX_DOWNLOAD_BYTES) {
        throw new CliError(
          `Downloaded image exceeds ${MAX_DOWNLOAD_BYTES} byte limit.`,
        )
      }
      chunks.push(value)
    }
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }

  if (totalBytes === 0) {
    throw new CliError("Downloaded image body was empty.")
  }
  return Buffer.concat(chunks, totalBytes)
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
 * @param {boolean} isJson
 * @returns {Record<string, string>}
 */
function buildGatewayHeaders(apiKey, isJson) {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: "application/json",
    originator: "codex_cli_rs",
    "user-agent": `codex_cli_rs/${CODEX_CLI_VERSION} (${osType()} ${release()}; ${machine()}) unknown`,
    version: CODEX_CLI_VERSION,
  }
  if (isJson) {
    headers["Content-Type"] = "application/json"
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  return headers
}

/**
 * @param {string | undefined} prompt
 * @param {string | undefined} promptFile
 * @returns {Promise<string>}
 */
async function readPromptInput(prompt, promptFile) {
  if (prompt && promptFile) {
    throw new CliError("Use --prompt or --prompt-file, not both.")
  }
  if (promptFile) {
    if (!existsSync(promptFile)) {
      throw new CliError(`Prompt file not found: ${promptFile}`)
    }
    const content = (await readFile(promptFile, "utf8")).trim()
    if (!content) {
      throw new CliError(`Prompt file is empty: ${promptFile}`)
    }
    return content
  }
  if (prompt && prompt.trim()) {
    return prompt.trim()
  }
  throw new CliError("Missing prompt. Provide --prompt or --prompt-file.")
}

/**
 * @param {string[]} inputs
 * @param {(text: string) => void} stderr
 * @returns {Promise<Array<{ kind: "url", url: string } | { kind: "file", path: string, bytes: Buffer, mime: string, name: string }>>}
 */
async function loadImageInputs(inputs, stderr) {
  const loaded = []
  let totalBytes = 0
  for (const raw of inputs) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (isRemoteOrDataImageUrl(trimmed)) {
      loaded.push({ kind: "url", url: trimmed })
      continue
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
    if (info.size > MAX_FILE_BYTES) {
      throw new CliError(
        `Image exceeds 64 MiB gateway limit: ${trimmed} (${info.size} bytes)`,
      )
    }
    if (info.size > WARN_IMAGE_BYTES) {
      stderr(`Warning: Image exceeds 50 MiB: ${trimmed}\n`)
    }
    totalBytes += info.size
    if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
      throw new CliError("Total image upload size exceeds 128 MiB limit.")
    }
    const bytes = await readFile(trimmed)
    const mime = detectImageMime(bytes, trimmed)
    loaded.push({
      kind: "file",
      path: trimmed,
      bytes,
      mime,
      name: path.basename(trimmed),
    })
  }
  return loaded
}

/**
 * @param {string} jsonlPath
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function readBatchJobs(jsonlPath) {
  if (!existsSync(jsonlPath)) {
    throw new CliError(`Batch input file not found: ${jsonlPath}`)
  }
  const raw = await readFile(jsonlPath, "utf8")
  const jobs = []
  const lines = raw.split(/\r?\n/u)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line || line.startsWith("#")) continue
    const lineNo = i + 1
    let item
    try {
      item = line.startsWith("{") ? JSON.parse(line) : line
    } catch (error) {
      throw new CliError(
        `Invalid JSON on line ${lineNo}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (typeof item === "string") {
      if (!item.trim()) throw new CliError(`Empty prompt on line ${lineNo}.`)
      jobs.push({ prompt: item.trim() })
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = /** @type {Record<string, unknown>} */ (item)
      if (typeof record.prompt !== "string" || !record.prompt.trim()) {
        throw new CliError(`Missing prompt for batch job on line ${lineNo}.`)
      }
      jobs.push({ ...record, prompt: record.prompt.trim() })
    } else {
      throw new CliError(
        `Invalid batch job on line ${lineNo}: expected JSON object or prompt string.`,
      )
    }
  }
  if (jobs.length === 0) {
    throw new CliError("No jobs found in batch input file.")
  }
  if (jobs.length > MAX_BATCH_JOBS) {
    throw new CliError(
      `Too many batch jobs (${jobs.length}); maximum is ${MAX_BATCH_JOBS}.`,
    )
  }
  return jobs
}

/**
 * @param {{
 *   endpoint: string,
 *   apiKey: string | undefined,
 *   bodyFactory: () => { body: string | FormData, isJson: boolean },
 *   maxAttempts: number,
 *   timeoutMs: number,
 *   fetchImpl: typeof fetch,
 *   sleep: (ms: number) => Promise<void>,
 *   stderr: (text: string) => void,
 * }} opts
 * @returns {Promise<Record<string, unknown>>}
 */
async function postImageRequest(opts) {
  let lastError
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    try {
      const { body, isJson } = opts.bodyFactory()
      const headers = buildGatewayHeaders(opts.apiKey, isJson)
      const response = await opts.fetchImpl(opts.endpoint, {
        method: "POST",
        headers,
        body,
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
          RETRYABLE_STATUSES.has(response.status)
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
            " Set GITHUB_COPILOT_API_KEY to a valid gateway API key."
          : ""
        throw new CliError(
          `Image request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}.${authHint}`,
        )
      }
      return asRecord(parsed)
    } catch (error) {
      if (error instanceof CliError) throw error
      lastError = error
      if (attempt < opts.maxAttempts) {
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 30_000)
        opts.stderr(
          `Network error on attempt ${attempt}/${opts.maxAttempts} (${error instanceof Error ? error.message : String(error)}); retrying in ${delayMs}ms...\n`,
        )
        await opts.sleep(delayMs)
        continue
      }
      throw new CliError(
        `Image request failed after ${opts.maxAttempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      )
    }
  }
  throw new CliError("Image request failed unexpectedly.")
}

/**
 * @param {Record<string, unknown>} response
 * @param {string[]} outputPaths
 * @param {{
 *   force: boolean,
 *   fetchImpl: typeof fetch,
 *   timeoutMs: number,
 *   stderr: (text: string) => void,
 * }} opts
 * @returns {Promise<{ written: string[], revisedPrompts: string[] }>}
 */
async function saveImageResponse(response, outputPaths, opts) {
  const items = Array.isArray(response.data) ? response.data : []
  if (items.length === 0) {
    throw new CliError(
      extractErrorMessage(response) ?? "Gateway returned no images in data[].",
    )
  }

  /** @type {string[]} */
  const written = []
  /** @type {string[]} */
  const revisedPrompts = []

  for (let i = 0; i < items.length && i < outputPaths.length; i += 1) {
    const item = asRecord(items[i])
    if (typeof item.revised_prompt === "string" && item.revised_prompt.trim()) {
      revisedPrompts.push(item.revised_prompt.trim())
    }

    /** @type {Buffer} */
    let bytes
    if (typeof item.b64_json === "string" && item.b64_json.trim()) {
      bytes = Buffer.from(item.b64_json, "base64")
    } else if (typeof item.url === "string" && item.url.trim()) {
      bytes = await downloadRemoteImage(
        item.url.trim(),
        opts.fetchImpl,
        opts.timeoutMs,
      )
    } else {
      throw new CliError(`Image item ${i} contained neither b64_json nor url.`)
    }

    const outPath = outputPaths[i]
    try {
      const actualMime = detectImageMime(bytes, outPath)
      const actualExt = extensionForMime(actualMime)
      const declaredExt = path.extname(outPath).slice(1).toLowerCase()
      const matches =
        actualExt === declaredExt
        || (actualExt === "jpeg" && declaredExt === "jpg")
      if (declaredExt && !matches) {
        opts.stderr(
          `Warning: ${outPath} contains ${actualMime} bytes (extension .${declaredExt}).\n`,
        )
      }
    } catch {
      // Keep raw bytes if upstream returned an uncommon image encoding.
    }

    await writeBytesAtomic(outPath, bytes, opts.force)
    written.push(outPath)
  }

  return { written, revisedPrompts }
}

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {string}
 */
export function usageText(env = process.env) {
  const defaultDir = resolveDefaultOutputDir(env)
  return `Usage:
  node image_gen.mjs <generate|edit|generate-batch> [options]

Commands:
  generate        Create new image(s) via POST /v1/images/generations
  edit            Edit existing image(s) via POST /v1/images/edits
  generate-batch  Generate multiple JSONL prompts concurrently

Common options:
  --base-url <url>           Gateway root URL (default: $COPILOT_API_BASE_URL or ${DEFAULT_BASE_URL})
  --provider <name>          Use provider-scoped /:provider/v1/images/* (e.g. codex, github-copilot, xai)
  --model <model>            Model or provider/model alias (default: ${DEFAULT_MODEL})
  --auto-model               Omit model field to use gateway default routing
  --prompt <text>            Prompt text
  --prompt-file <path>       Read prompt text from UTF-8 file
  --n <1-10>                 Number of variants per prompt (default: 1)
  --size <size>              Image size (default: ${DEFAULT_SIZE}; e.g. 1024x1024, 1536x1024, 2048x1152)
  --quality <level>          low | medium | high | auto (default: ${DEFAULT_QUALITY})
  --background <mode>        transparent | opaque | auto
  --output-format <fmt>      png | jpeg | jpg | webp | gif (default: ${DEFAULT_OUTPUT_FORMAT})
  --output-compression <n>   0-100 (jpeg/webp only)
  --frame-count <2-64>       Animated GIF frame count (generate + --output-format gif)
  --frame-duration-ms <ms>   Animated GIF frame duration 20-2000ms (generate + --output-format gif)
  --moderation <mode>        auto | low
  --aspect-ratio <ratio>     xAI aspect ratio (e.g. 16:9, 1:1, auto)
  --resolution <res>         xAI resolution: 1k | 2k
  --out <path>               Output file path (default: unique file in ${defaultDir})
  --out-dir <dir>            Output directory (for generate-batch, default: unique dir in ${defaultDir})
  --force                    Overwrite existing output file(s)
  --timeout-ms <ms>          Per-request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --max-attempts <1-10>      Retry attempts for 429/5xx/network errors (default: ${DEFAULT_MAX_ATTEMPTS})
  --dry-run                  Print request preview without calling the gateway
  --json                     Emit structured JSON result to stdout
  -h, --help                 Show this help message

Prompt augmentation hints:
  --augment / --no-augment   Enable/disable structured prompt hints (default: enabled)
  --use-case <slug>          Taxonomy slug (e.g. product-mockup, ui-mockup, precise-object-edit)
  --scene <text>             Scene/backdrop
  --subject <text>           Main subject
  --style <text>             Style/medium
  --composition <text>       Composition/framing
  --lighting <text>          Lighting/mood
  --palette <text>           Color palette
  --materials <text>         Materials/textures
  --text <text>              Exact verbatim text to render
  --constraints <text>       Invariants / constraints
  --negative <text>          Avoid list

Edit-only options:
  --image <path-or-url>      Input image path or URL (repeatable; order preserved)
  --mask <path-or-url>       Optional PNG mask with alpha channel
  --input-fidelity <lvl>     low | high (not supported on gpt-image-2)
  --transport <mode>         multipart | json (default: multipart)

Batch-only options:
  --input <prompts.jsonl>    Path to JSONL prompt jobs file (required)
  --concurrency <1-25>       Parallel requests (default: ${DEFAULT_CONCURRENCY})
  --fail-fast                Stop scheduling new jobs after first failure

Environment:
  GITHUB_COPILOT_API_KEY     Gateway API key (sent as Authorization: Bearer <key>)
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
    && command !== "edit"
    && command !== "generate-batch"
  ) {
    throw new CliError(
      `Unknown command "${command}". Expected generate, edit, or generate-batch.`,
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
        provider: { type: "string" },
        model: { type: "string" },
        "auto-model": { type: "boolean" },
        prompt: { type: "string" },
        "prompt-file": { type: "string" },
        n: { type: "string" },
        size: { type: "string" },
        quality: { type: "string" },
        background: { type: "string" },
        "output-format": { type: "string" },
        "output-compression": { type: "string" },
        "frame-count": { type: "string" },
        "frame-duration-ms": { type: "string" },
        moderation: { type: "string" },
        "aspect-ratio": { type: "string" },
        resolution: { type: "string" },
        out: { type: "string" },
        "out-dir": { type: "string" },
        force: { type: "boolean" },
        "timeout-ms": { type: "string" },
        "max-attempts": { type: "string" },
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
        augment: { type: "boolean" },
        "no-augment": { type: "boolean" },
        "use-case": { type: "string" },
        scene: { type: "string" },
        subject: { type: "string" },
        style: { type: "string" },
        composition: { type: "string" },
        lighting: { type: "string" },
        palette: { type: "string" },
        materials: { type: "string" },
        text: { type: "string" },
        constraints: { type: "string" },
        negative: { type: "string" },
        image: { type: "string", multiple: true },
        mask: { type: "string" },
        "input-fidelity": { type: "string" },
        transport: { type: "string" },
        input: { type: "string" },
        concurrency: { type: "string" },
        "fail-fast": { type: "boolean" },
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
 * @returns {Record<string, string | undefined>}
 */
function extractHintFields(values) {
  return {
    use_case:
      typeof values["use-case"] === "string" ? values["use-case"] : undefined,
    scene: typeof values.scene === "string" ? values.scene : undefined,
    subject: typeof values.subject === "string" ? values.subject : undefined,
    style: typeof values.style === "string" ? values.style : undefined,
    composition:
      typeof values.composition === "string" ? values.composition : undefined,
    lighting: typeof values.lighting === "string" ? values.lighting : undefined,
    palette: typeof values.palette === "string" ? values.palette : undefined,
    materials:
      typeof values.materials === "string" ? values.materials : undefined,
    text: typeof values.text === "string" ? values.text : undefined,
    constraints:
      typeof values.constraints === "string" ? values.constraints : undefined,
    negative: typeof values.negative === "string" ? values.negative : undefined,
  }
}

/**
 * @param {string | undefined} rawModel
 * @param {boolean} autoModel
 * @param {string | undefined} provider
 * @returns {string | undefined}
 */
function resolveModelOption(rawModel, autoModel, provider) {
  if (autoModel) return undefined
  if (rawModel === undefined) return provider ? undefined : DEFAULT_MODEL
  const trimmed = rawModel.trim()
  return trimmed || undefined
}

/**
 * @param {"generate" | "edit" | "generate-batch"} command
 * @param {Record<string, unknown>} values
 */
function validateSubcommandFlags(command, values) {
  const hasEditFlags =
    (Array.isArray(values.image) && values.image.length > 0)
    || values.mask !== undefined
    || values["input-fidelity"] !== undefined
    || values.transport !== undefined
  const hasBatchFlags =
    values.input !== undefined
    || values.concurrency !== undefined
    || Boolean(values["fail-fast"])

  if (command === "generate") {
    if (hasEditFlags) {
      throw new CliError(
        "Flags --image, --mask, --input-fidelity, and --transport are only valid for the `edit` subcommand.",
      )
    }
    if (hasBatchFlags) {
      throw new CliError(
        "Flags --input, --concurrency, and --fail-fast are only valid for the `generate-batch` subcommand.",
      )
    }
  } else if (command === "edit") {
    if (hasBatchFlags) {
      throw new CliError(
        "Flags --input, --concurrency, and --fail-fast are only valid for the `generate-batch` subcommand.",
      )
    }
  } else if (command === "generate-batch") {
    if (hasEditFlags) {
      throw new CliError(
        "Flags --image, --mask, --input-fidelity, and --transport are not supported by `generate-batch`.",
      )
    }
    if (values.prompt !== undefined || values["prompt-file"] !== undefined) {
      throw new CliError(
        "Use --input <prompts.jsonl> instead of --prompt/--prompt-file with `generate-batch`.",
      )
    }
  }
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

/**
 * @param {string[]} argv
 * @param {CliDeps} [deps={}]
 * @returns {Promise<ImageGenRunResult | null>}
 */
export async function runImageGen(argv, deps = {}) {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const stdout = deps.stdout ?? ((text) => process.stdout.write(text))
  const stderr = deps.stderr ?? ((text) => process.stderr.write(text))
  const sleep =
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  const parsed = parseCliArgs(argv)
  if (parsed.help) {
    stdout(usageText(env))
    return null
  }

  const command = /** @type {"generate" | "edit" | "generate-batch"} */ (
    parsed.command
  )
  const { values } = parsed
  validateSubcommandFlags(command, values)
  if (values.augment && values["no-augment"]) {
    throw new CliError("Do not pass both --augment and --no-augment.")
  }
  const augment = !values["no-augment"]
  const dryRun = Boolean(values["dry-run"])
  const force = Boolean(values.force)
  const jsonOutput = Boolean(values.json)

  const provider = validateProvider(
    /** @type {string | undefined} */ (values.provider),
  )
  const baseUrl = normalizeBaseUrl(
    /** @type {string | undefined} */ (values["base-url"])
      ?? env.COPILOT_API_BASE_URL,
  )
  const apiKey = (env.GITHUB_COPILOT_API_KEY ?? "").trim() || undefined
  const explicitCliModel =
    values.model !== undefined ?
      String(values.model).trim() || undefined
    : undefined
  const model = resolveModelOption(
    /** @type {string | undefined} */ (values.model),
    Boolean(values["auto-model"]),
    provider,
  )
  const n =
    values.n !== undefined ? parseIntRange(String(values.n), "--n", 1, 10) : 1
  const size =
    typeof values.size === "string" && values.size.trim() ?
      values.size.trim()
    : DEFAULT_SIZE
  const quality =
    typeof values.quality === "string" && values.quality.trim() ?
      values.quality.trim().toLowerCase()
    : DEFAULT_QUALITY
  const background =
    typeof values.background === "string" ?
      values.background.trim().toLowerCase()
    : undefined
  const outputFormat = normalizeOutputFormat(
    /** @type {string | undefined} */ (values["output-format"]),
  )
  const outputCompression =
    values["output-compression"] !== undefined ?
      parseIntRange(
        String(values["output-compression"]),
        "--output-compression",
        0,
        100,
      )
    : undefined
  const frameCount =
    values["frame-count"] !== undefined ?
      parseIntRange(String(values["frame-count"]), "--frame-count", 2, 64)
    : undefined
  const frameDurationMs =
    values["frame-duration-ms"] !== undefined ?
      parseIntRange(
        String(values["frame-duration-ms"]),
        "--frame-duration-ms",
        20,
        2000,
      )
    : undefined
  const moderation =
    typeof values.moderation === "string" ?
      values.moderation.trim().toLowerCase()
    : undefined
  const aspectRatio =
    typeof values["aspect-ratio"] === "string" ?
      values["aspect-ratio"].trim()
    : undefined
  const resolution =
    typeof values.resolution === "string" ?
      values.resolution.trim().toLowerCase()
    : undefined
  const inputFidelity =
    typeof values["input-fidelity"] === "string" ?
      values["input-fidelity"].trim().toLowerCase()
    : undefined
  const timeoutMs =
    values["timeout-ms"] !== undefined ?
      parseIntRange(
        String(values["timeout-ms"]),
        "--timeout-ms",
        1000,
        3_600_000,
      )
    : DEFAULT_TIMEOUT_MS
  const maxAttempts =
    values["max-attempts"] !== undefined ?
      parseIntRange(String(values["max-attempts"]), "--max-attempts", 1, 10)
    : DEFAULT_MAX_ATTEMPTS

  if (command === "generate") {
    const endpoint = buildEndpointUrl(baseUrl, "generations", provider)
    const rawPrompt = await readPromptInput(
      /** @type {string | undefined} */ (values.prompt),
      /** @type {string | undefined} */ (values["prompt-file"]),
    )
    const prompt = buildAugmentedPrompt(
      augment,
      rawPrompt,
      extractHintFields(values),
    )

    validateImageOptions({
      operation: "generations",
      model,
      provider,
      size,
      quality,
      background,
      outputFormat,
      outputCompression,
      inputFidelity: undefined,
      moderation,
      frameCount,
      frameDurationMs,
      aspectRatio,
      resolution,
    })

    const payload = {
      ...(model ? { model } : {}),
      prompt,
      n,
      size,
      quality,
      ...(background ? { background } : {}),
      output_format: outputFormat,
      ...(outputCompression !== undefined ?
        { output_compression: outputCompression }
      : {}),
      ...(outputFormat === "gif" ?
        {
          frame_count: frameCount ?? 9,
          frame_duration_ms: frameDurationMs ?? 200,
        }
      : {}),
      ...(moderation ? { moderation } : {}),
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      ...(resolution ? { resolution } : {}),
    }

    const outPath =
      typeof values.out === "string" && values.out.trim() ?
        values.out.trim()
      : buildDefaultOutputPath(outputFormat, env, "image")
    const outputPaths = buildOutputPaths(
      outPath,
      outputFormat,
      n,
      typeof values["out-dir"] === "string" ?
        values["out-dir"].trim()
      : undefined,
      stderr,
    )

    checkAuthEnvironment(apiKey, baseUrl, dryRun, stderr)

    if (dryRun) {
      stdout(
        `${JSON.stringify(
          {
            dry_run: true,
            endpoint,
            auth:
              apiKey ?
                "Bearer [REDACTED] (from GITHUB_COPILOT_API_KEY)"
              : "none (GITHUB_COPILOT_API_KEY unset)",
            outputs: outputPaths,
            payload,
          },
          null,
          2,
        )}\n`,
      )
      return { command, endpoint, dryRun: true, outputs: outputPaths }
    }

    assertOutputsWritable(outputPaths, force)
    stderr(`Calling ${endpoint} (generate)...\n`)
    const started = Date.now()
    const response = await postImageRequest({
      endpoint,
      apiKey,
      bodyFactory: () => ({ body: JSON.stringify(payload), isJson: true }),
      maxAttempts,
      timeoutMs,
      fetchImpl,
      sleep,
      stderr,
    })
    const saved = await saveImageResponse(response, outputPaths, {
      force,
      fetchImpl,
      timeoutMs,
      stderr,
    })
    stderr(`Completed in ${((Date.now() - started) / 1000).toFixed(1)}s.\n`)

    if (jsonOutput) {
      stdout(
        `${JSON.stringify(
          {
            command,
            endpoint,
            model: model ?? "(gateway default)",
            outputs: saved.written,
            revised_prompts: saved.revisedPrompts,
          },
          null,
          2,
        )}\n`,
      )
    } else {
      for (const writtenPath of saved.written) {
        stdout(`Wrote ${writtenPath}\n`)
      }
      for (const revised of saved.revisedPrompts) {
        stderr(`Revised prompt: ${revised}\n`)
      }
    }

    return {
      command,
      endpoint,
      dryRun: false,
      outputs: saved.written,
      revisedPrompts: saved.revisedPrompts,
    }
  }

  if (command === "edit") {
    const endpoint = buildEndpointUrl(baseUrl, "edits", provider)
    const rawPrompt = await readPromptInput(
      /** @type {string | undefined} */ (values.prompt),
      /** @type {string | undefined} */ (values["prompt-file"]),
    )
    const prompt = buildAugmentedPrompt(
      augment,
      rawPrompt,
      extractHintFields(values),
    )

    const imageArgs = /** @type {string[] | undefined} */ (values.image ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
    if (imageArgs.length === 0) {
      throw new CliError("edit requires at least one --image <path-or-url>.")
    }
    const maskArg =
      typeof values.mask === "string" && values.mask.trim() ?
        values.mask.trim()
      : undefined
    const transport =
      validateChoice(
        /** @type {string | undefined} */ (values.transport),
        ALLOWED_TRANSPORTS,
        "--transport",
      ) ?? "multipart"

    validateImageOptions({
      operation: "edits",
      model,
      provider,
      size,
      quality,
      background,
      outputFormat,
      outputCompression,
      inputFidelity,
      moderation,
      frameCount,
      frameDurationMs,
      aspectRatio,
      resolution,
      imageCount: imageArgs.length,
      hasMask: Boolean(maskArg),
    })

    const images = await loadImageInputs(imageArgs, stderr)
    const maskList = maskArg ? await loadImageInputs([maskArg], stderr) : []
    const maskInput = maskList[0]
    if (
      maskInput
      && maskInput.kind === "file"
      && maskInput.mime !== "image/png"
    ) {
      stderr(
        `Warning: Mask should be a PNG with an alpha channel: ${maskInput.path}\n`,
      )
    }

    const outPath =
      typeof values.out === "string" && values.out.trim() ?
        values.out.trim()
      : buildDefaultOutputPath(outputFormat, env, "edit")
    const outputPaths = buildOutputPaths(
      outPath,
      outputFormat,
      n,
      typeof values["out-dir"] === "string" ?
        values["out-dir"].trim()
      : undefined,
      stderr,
    )

    const fields = {
      ...(model ? { model } : {}),
      prompt,
      n,
      size,
      quality,
      ...(background ? { background } : {}),
      output_format: outputFormat,
      ...(outputCompression !== undefined ?
        { output_compression: outputCompression }
      : {}),
      ...(inputFidelity ? { input_fidelity: inputFidelity } : {}),
      ...(moderation ? { moderation } : {}),
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      ...(resolution ? { resolution } : {}),
    }

    checkAuthEnvironment(apiKey, baseUrl, dryRun, stderr)

    if (dryRun) {
      stdout(
        `${JSON.stringify(
          {
            dry_run: true,
            endpoint,
            transport,
            auth:
              apiKey ?
                "Bearer [REDACTED] (from GITHUB_COPILOT_API_KEY)"
              : "none (GITHUB_COPILOT_API_KEY unset)",
            outputs: outputPaths,
            images: images.map((item) =>
              item.kind === "file" ?
                { path: item.path, mime: item.mime, bytes: item.bytes.length }
              : { url: item.url },
            ),
            ...(maskInput ?
              {
                mask:
                  maskInput.kind === "file" ?
                    {
                      path: maskInput.path,
                      mime: maskInput.mime,
                      bytes: maskInput.bytes.length,
                    }
                  : { url: maskInput.url },
              }
            : {}),
            payload: fields,
          },
          null,
          2,
        )}\n`,
      )
      return { command, endpoint, dryRun: true, outputs: outputPaths }
    }

    const bodyFactory = () => {
      if (transport === "json") {
        const toRef = (/** @type {(typeof images)[number]} */ item) => ({
          image_url:
            item.kind === "url" ?
              item.url
            : `data:${item.mime};base64,${item.bytes.toString("base64")}`,
        })
        return {
          isJson: true,
          body: JSON.stringify({
            ...fields,
            images: images.map(toRef),
            ...(maskInput ? { mask: toRef(maskInput) } : {}),
          }),
        }
      }

      const form = new FormData()
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) form.set(key, String(value))
      }
      for (const item of images) {
        if (item.kind === "url") {
          form.append("image", item.url)
        } else {
          form.append(
            "image",
            new Blob([item.bytes], { type: item.mime }),
            item.name,
          )
        }
      }
      if (maskInput) {
        if (maskInput.kind === "url") {
          form.set("mask", maskInput.url)
        } else {
          form.set(
            "mask",
            new Blob([maskInput.bytes], { type: maskInput.mime }),
            maskInput.name,
          )
        }
      }
      return { isJson: false, body: form }
    }

    assertOutputsWritable(outputPaths, force)
    stderr(
      `Calling ${endpoint} (edit, ${images.length} image(s), ${transport})...\n`,
    )
    const started = Date.now()
    const response = await postImageRequest({
      endpoint,
      apiKey,
      bodyFactory,
      maxAttempts,
      timeoutMs,
      fetchImpl,
      sleep,
      stderr,
    })
    const saved = await saveImageResponse(response, outputPaths, {
      force,
      fetchImpl,
      timeoutMs,
      stderr,
    })
    stderr(`Completed in ${((Date.now() - started) / 1000).toFixed(1)}s.\n`)

    if (jsonOutput) {
      stdout(
        `${JSON.stringify(
          {
            command,
            endpoint,
            transport,
            model: model ?? "(gateway default)",
            outputs: saved.written,
            revised_prompts: saved.revisedPrompts,
          },
          null,
          2,
        )}\n`,
      )
    } else {
      for (const writtenPath of saved.written) {
        stdout(`Wrote ${writtenPath}\n`)
      }
      for (const revised of saved.revisedPrompts) {
        stderr(`Revised prompt: ${revised}\n`)
      }
    }

    return {
      command,
      endpoint,
      dryRun: false,
      outputs: saved.written,
      revisedPrompts: saved.revisedPrompts,
    }
  }

  // generate-batch
  const inputFile =
    typeof values.input === "string" && values.input.trim() ?
      values.input.trim()
    : undefined
  const outDir =
    typeof values["out-dir"] === "string" && values["out-dir"].trim() ?
      values["out-dir"].trim()
    : buildDefaultBatchOutputDir(env)
  if (!inputFile) {
    throw new CliError("generate-batch requires --input <prompts.jsonl>.")
  }
  const concurrency =
    values.concurrency !== undefined ?
      parseIntRange(String(values.concurrency), "--concurrency", 1, 25)
    : DEFAULT_CONCURRENCY
  const failFast = Boolean(values["fail-fast"])

  const jobs = await readBatchJobs(inputFile)
  const cliHints = extractHintFields(values)

  const preparedJobs = jobs.map((job, idx) => {
    const jobIndex = idx + 1
    const jobProvider = validateProvider(
      typeof job.provider === "string" ? job.provider : provider,
    )
    const jobEndpoint = buildEndpointUrl(baseUrl, "generations", jobProvider)
    const jobModel =
      typeof job.model === "string" ? job.model.trim() || undefined
      : jobProvider && !explicitCliModel ? undefined
      : model
    const jobN =
      job.n !== undefined ?
        parseIntRange(String(job.n), `job ${jobIndex} n`, 1, 10)
      : n
    const jobSize =
      typeof job.size === "string" && job.size.trim() ? job.size.trim() : size
    const jobQuality =
      typeof job.quality === "string" && job.quality.trim() ?
        job.quality.trim().toLowerCase()
      : quality
    const jobBackground =
      typeof job.background === "string" ?
        job.background.trim().toLowerCase()
      : background
    const jobOutputFormat = normalizeOutputFormat(
      typeof job.output_format === "string" ? job.output_format : outputFormat,
    )
    const jobCompression =
      job.output_compression !== undefined ?
        parseIntRange(
          String(job.output_compression),
          `job ${jobIndex} output_compression`,
          0,
          100,
        )
      : outputCompression
    const jobModeration =
      typeof job.moderation === "string" ?
        job.moderation.trim().toLowerCase()
      : moderation
    const jobFrameCount =
      job.frame_count !== undefined ?
        parseIntRange(
          String(job.frame_count),
          `job ${jobIndex} frame_count`,
          2,
          64,
        )
      : frameCount
    const jobFrameDurationMs =
      job.frame_duration_ms !== undefined ?
        parseIntRange(
          String(job.frame_duration_ms),
          `job ${jobIndex} frame_duration_ms`,
          20,
          2000,
        )
      : frameDurationMs
    const jobAspectRatio =
      typeof job.aspect_ratio === "string" ?
        job.aspect_ratio.trim()
      : aspectRatio
    const jobResolution =
      typeof job.resolution === "string" ?
        job.resolution.trim().toLowerCase()
      : resolution

    validateImageOptions({
      operation: "generations",
      model: jobModel,
      provider: jobProvider,
      size: jobSize,
      quality: jobQuality,
      background: jobBackground,
      outputFormat: jobOutputFormat,
      outputCompression: jobCompression,
      inputFidelity: undefined,
      moderation: jobModeration,
      frameCount: jobFrameCount,
      frameDurationMs: jobFrameDurationMs,
      aspectRatio: jobAspectRatio,
      resolution: jobResolution,
    })

    const mergedHints = { ...cliHints }
    for (const key of Object.keys(cliHints)) {
      if (typeof job[key] === "string" && job[key].trim()) {
        mergedHints[key] = job[key]
      }
    }
    const rawJobPrompt = String(job.prompt)
    const jobPrompt = buildAugmentedPrompt(augment, rawJobPrompt, mergedHints)

    const payload = {
      ...(jobModel ? { model: jobModel } : {}),
      prompt: jobPrompt,
      n: jobN,
      size: jobSize,
      quality: jobQuality,
      ...(jobBackground ? { background: jobBackground } : {}),
      output_format: jobOutputFormat,
      ...(jobCompression !== undefined ?
        { output_compression: jobCompression }
      : {}),
      ...(jobOutputFormat === "gif" ?
        {
          frame_count: jobFrameCount ?? 9,
          frame_duration_ms: jobFrameDurationMs ?? 200,
        }
      : {}),
      ...(jobModeration ? { moderation: jobModeration } : {}),
      ...(jobAspectRatio ? { aspect_ratio: jobAspectRatio } : {}),
      ...(jobResolution ? { resolution: jobResolution } : {}),
    }

    const outputs = buildBatchJobOutputPaths({
      outDir,
      outputFormat: jobOutputFormat,
      index: jobIndex,
      prompt: rawJobPrompt,
      n: jobN,
      explicitOut: typeof job.out === "string" ? job.out : undefined,
      stderr,
    })

    return { jobIndex, endpoint: jobEndpoint, payload, outputs }
  })

  // Detect duplicate output paths across jobs in the same batch before dispatching.
  const plannedOutputs = new Map()
  for (const job of preparedJobs) {
    for (const outputPath of job.outputs) {
      const resolved = path.resolve(outputPath)
      const previousJob = plannedOutputs.get(resolved)
      if (previousJob !== undefined) {
        throw new CliError(
          `Duplicate batch output path "${outputPath}" between job ${previousJob} and job ${job.jobIndex}. Use unique "out" filenames.`,
        )
      }
      plannedOutputs.set(resolved, job.jobIndex)
    }
  }

  checkAuthEnvironment(apiKey, baseUrl, dryRun, stderr)
  const defaultEndpoint = buildEndpointUrl(baseUrl, "generations", provider)

  if (dryRun) {
    stdout(
      `${JSON.stringify(
        {
          dry_run: true,
          command,
          out_dir: outDir,
          auth:
            apiKey ?
              "Bearer [REDACTED] (from GITHUB_COPILOT_API_KEY)"
            : "none (GITHUB_COPILOT_API_KEY unset)",
          concurrency,
          jobs: preparedJobs.map((job) => ({
            job: job.jobIndex,
            endpoint: job.endpoint,
            outputs: job.outputs,
            payload: job.payload,
          })),
        },
        null,
        2,
      )}\n`,
    )
    return {
      command,
      endpoint: defaultEndpoint,
      dryRun: true,
      outputs: preparedJobs.flatMap((job) => job.outputs),
      totalJobs: preparedJobs.length,
    }
  }

  assertOutputsWritable(
    preparedJobs.flatMap((job) => job.outputs),
    force,
  )
  stderr(
    `Starting batch of ${preparedJobs.length} job(s) with concurrency=${concurrency}...\n`,
  )
  const started = Date.now()
  let nextIndex = 0
  let stopRequested = false
  let succeededJobs = 0
  /** @type {string[]} */
  const allWritten = []
  /** @type {Array<{ job: number, error: string }>} */
  const failures = []

  const worker = async () => {
    while (!stopRequested) {
      const idx = nextIndex
      nextIndex += 1
      if (idx >= preparedJobs.length) return
      const job = preparedJobs[idx]
      try {
        const response = await postImageRequest({
          endpoint: job.endpoint,
          apiKey,
          bodyFactory: () => ({
            body: JSON.stringify(job.payload),
            isJson: true,
          }),
          maxAttempts,
          timeoutMs,
          fetchImpl,
          sleep,
          stderr,
        })
        const saved = await saveImageResponse(response, job.outputs, {
          force,
          fetchImpl,
          timeoutMs,
          stderr,
        })
        succeededJobs += 1
        allWritten.push(...saved.written)
        if (!jsonOutput) {
          for (const writtenPath of saved.written) {
            stdout(`Wrote ${writtenPath}\n`)
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push({ job: job.jobIndex, error: message })
        stderr(`[${job.jobIndex}/${preparedJobs.length}] Failed: ${message}\n`)
        if (failFast) {
          stopRequested = true
          return
        }
      }
    }
  }

  const workerCount = Math.min(concurrency, preparedJobs.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  const skippedJobs = Math.max(
    0,
    preparedJobs.length - succeededJobs - failures.length,
  )
  const skippedSuffix = skippedJobs > 0 ? `, ${skippedJobs} skipped` : ""
  stderr(
    `Batch finished in ${((Date.now() - started) / 1000).toFixed(1)}s (${succeededJobs}/${preparedJobs.length} succeeded, ${failures.length} failed${skippedSuffix}).\n`,
  )

  if (jsonOutput) {
    stdout(
      `${JSON.stringify(
        {
          command,
          endpoint: defaultEndpoint,
          out_dir: outDir,
          total_jobs: preparedJobs.length,
          succeeded_jobs: succeededJobs,
          failed_jobs: failures.length,
          skipped_jobs: skippedJobs,
          outputs: allWritten,
          failures,
        },
        null,
        2,
      )}\n`,
    )
  }

  if (failures.length > 0) {
    throw new CliError(
      `${failures.length} of ${preparedJobs.length} batch job(s) failed.`,
    )
  }

  return {
    command,
    endpoint: defaultEndpoint,
    dryRun: false,
    outputs: allWritten,
    failedJobs: 0,
    totalJobs: preparedJobs.length,
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
  runImageGen(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Error: ${message}\n`)
    process.exitCode = error instanceof CliError ? error.exitCode : 1
  })
}
