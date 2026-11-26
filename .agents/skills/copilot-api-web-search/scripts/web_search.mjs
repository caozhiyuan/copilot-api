#!/usr/bin/env node
/**
 * CLI for calling a copilot-api gateway's Alpha Search endpoint
 * (/v1/alpha/search or /:provider/v1/alpha/search).
 *
 * Uses zero third-party dependencies (Node.js 20+ or Bun).
 * Authentication uses GITHUB_COPILOT_API_KEY and gateway URL uses
 * COPILOT_API_BASE_URL (default: http://localhost:4141).
 */

import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { machine, release, type as osType } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

export const DEFAULT_BASE_URL = "http://localhost:4141"
export const DEFAULT_MODEL = "gpt-6-luna"
export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_ATTEMPTS = 3
export const CODEX_CLI_VERSION = "0.166.0"

const RESPONSE_LENGTHS = new Set(["short", "medium", "long"])
const CONTEXT_SIZES = new Set(["low", "medium", "high"])
const WEB_ACCESS_MODES = new Set(["live", "cached", "indexed", "true", "false"])
const FINANCE_TYPES = new Set(["equity", "fund", "crypto", "index"])
const SPORTS_FNS = new Set(["schedule", "standings"])
const SPORTS_LEAGUES = new Set([
  "nba",
  "wnba",
  "nfl",
  "nhl",
  "mlb",
  "epl",
  "ncaamb",
  "ncaawb",
  "ipl",
])
const REASONING_SUMMARIES = new Set(["auto", "concise", "detailed", "none"])
const OUTPUT_FORMATS = new Set(["text", "json"])
const UTC_OFFSET_PATTERN = /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/u
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])

/**
 * @typedef {{
 *   env?: Record<string, string | undefined>,
 *   fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
 *   stdout?: (text: string) => void,
 *   stderr?: (text: string) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   uuid?: () => string,
 * }} CliDeps
 */

/**
 * @typedef {{
 *   endpoint: string,
 *   sessionId: string,
 *   payload: Record<string, unknown>,
 *   response?: Record<string, unknown>,
 *   dryRun: boolean,
 *   outPath?: string,
 * }} AlphaSearchRunResult
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
 * @param {string} value
 * @param {string} name
 * @param {number} [min=0]
 * @param {number} [max=Number.MAX_SAFE_INTEGER]
 * @returns {number}
 */
function parseIntOption(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const trimmed = value.trim()
  if (!/^\d+$/u.test(trimmed)) {
    throw new CliError(`${name} must be a non-negative integer, got "${value}"`)
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
 * @param {string | undefined} raw
 * @returns {boolean | string | undefined}
 */
function parseWebAccess(raw) {
  const normalized = validateChoice(raw, WEB_ACCESS_MODES, "--web-access")
  if (normalized === undefined) return undefined
  if (normalized === "true") return true
  if (normalized === "false") return false
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
 * @param {string} filePath
 * @param {string} content
 * @param {boolean} force
 */
async function writeFileAtomic(filePath, content, force) {
  if (existsSync(filePath) && !force) {
    throw new CliError(
      `Output already exists: ${filePath} (pass --force to overwrite)`,
    )
  }
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true })
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" })
    await rename(tempPath, filePath)
  } finally {
    await rm(tempPath, { force: true })
  }
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
 * @param {string} sessionId
 * @param {string | undefined} apiKey
 * @returns {Record<string, string>}
 */
function buildRequestHeaders(sessionId, apiKey) {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    originator: "codex_cli_rs",
    "user-agent": `codex_cli_rs/${CODEX_CLI_VERSION} (${osType()} ${release()}; ${machine()}) unknown`,
    version: CODEX_CLI_VERSION,
    "x-codex-turn-metadata": JSON.stringify({ session_id: sessionId }),
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  return headers
}

/**
 * @param {string} baseUrl
 * @param {string | undefined} provider
 * @returns {string}
 */
export function buildEndpointUrl(baseUrl, provider) {
  if (provider) {
    return `${baseUrl}/${encodeURIComponent(provider)}/v1/alpha/search`
  }
  return `${baseUrl}/v1/alpha/search`
}

export function usageText() {
  return `Usage:
  node web_search.mjs <command> [options]

Commands:
  search       Run one or more web search queries (commands.search_query / image_query)
  open         Open a URL or prior-turn ref_id (commands.open)
  find         Find a text pattern inside an opened snapshot or URL (commands.find)
  click        Click a link index from an opened snapshot (commands.click)
  structured   Run finance, weather, sports, or time commands
  raw          Send raw commands JSON or a full request payload file

Common options:
  --base-url <url>           Gateway root URL (default: $COPILOT_API_BASE_URL or ${DEFAULT_BASE_URL})
  --provider <name>          Use provider-scoped /:provider/v1/alpha/search (e.g. codex, deepseek)
  --model <model>            Model or provider/model alias (default: ${DEFAULT_MODEL})
  --session-id <id>          Session ID to reuse across search/open/find/click turns
  --response-length <len>    short | medium | long
  --max-output-tokens <n>    Optional output token ceiling
  --reasoning-effort <lvl>   Optional reasoning effort (e.g. low, medium, high)
  --reasoning-summary <mode> auto | concise | detailed | none
  --format <text|json>       Output format (default: text)
  --out <path>               Write formatted output to file
  --force                    Overwrite existing --out file
  --timeout-ms <ms>          Per-attempt HTTP timeout (default: ${DEFAULT_TIMEOUT_MS})
  --max-attempts <n>         Retry attempts for 429/5xx/network errors (default: ${DEFAULT_MAX_ATTEMPTS})
  --dry-run                  Print request preview without calling the gateway
  -h, --help                 Show this help message

Search options:
  --query <q>                Web search query (repeatable)
  --image-query <q>          Image search query (repeatable)
  --recency <days>           Recency filter in days (unsigned integer)
  --domain <host>            Restrict query to domain (repeatable)
  --allowed-domain <host>    settings.filters.allowed_domains entry (repeatable)
  --blocked-domain <host>    settings.filters.blocked_domains entry (repeatable)
  --context-size <size>      low | medium | high
  --web-access <mode>        live | cached | indexed | true | false
  --country <code>           Approximate user_location country
  --region <name>            Approximate user_location region
  --city <name>              Approximate user_location city
  --timezone <iana>          Approximate user_location timezone
  --image-max-results <n>    settings.image_settings.max_results
  --image-caption            Set settings.image_settings.caption=true
  --no-image-caption         Set settings.image_settings.caption=false

Open / Find / Click options:
  --ref <ref-or-url>         ref_id (e.g. turn0search0, turn0view0) or http(s) URL (repeatable for open)
  --lineno <n>               Starting line number for open
  --pattern <text>           Pattern to search for in find
  --link-id <n>              Link index for click

Structured options:
  --ticker <sym>             Finance ticker (requires --asset-type)
  --asset-type <type>        equity | fund | crypto | index
  --market <mkt>             Optional finance market
  --location <place>         Weather location
  --start <date>             Optional weather start date
  --duration <days>          Optional weather duration
  --sports-fn <fn>           schedule | standings (requires --league)
  --league <league>          nba | wnba | nfl | nhl | mlb | epl | ncaamb | ncaawb | ipl
  --team <name>              Optional sports team
  --opponent <name>          Optional sports opponent
  --date-from <date>         Optional sports start date
  --date-to <date>           Optional sports end date
  --num-games <n>            Optional sports game count
  --locale <locale>          Optional sports locale
  --utc-offset <+HH:MM>      Time lookup offset (e.g. +08:00, -07:00)

Raw options:
  --commands-json <json>     JSON object for the commands field
  --commands-file <path>     Path to a JSON file containing the commands object
  --payload-file <path>      Path to a JSON file containing a full alpha-search request body

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
  const validCommands = new Set([
    "search",
    "open",
    "find",
    "click",
    "structured",
    "raw",
  ])
  if (!validCommands.has(command)) {
    throw new CliError(
      `Unknown command "${command}". Expected one of: ${[...validCommands].join(", ")}.`,
    )
  }

  const normalizedArgs = []
  const rawArgs = argv.slice(1)
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i]
    if (arg === "--utc-offset" && i + 1 < rawArgs.length) {
      normalizedArgs.push(`--utc-offset=${rawArgs[i + 1]}`)
      i += 1
      continue
    }
    normalizedArgs.push(arg)
  }

  let parsed
  try {
    parsed = parseArgs({
      args: normalizedArgs,
      strict: true,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        "base-url": { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        "session-id": { type: "string" },
        "response-length": { type: "string" },
        "max-output-tokens": { type: "string" },
        "reasoning-effort": { type: "string" },
        "reasoning-summary": { type: "string" },
        format: { type: "string" },
        out: { type: "string" },
        force: { type: "boolean" },
        "timeout-ms": { type: "string" },
        "max-attempts": { type: "string" },
        "dry-run": { type: "boolean" },
        query: { type: "string", short: "q", multiple: true },
        "image-query": { type: "string", multiple: true },
        recency: { type: "string" },
        domain: { type: "string", multiple: true },
        "allowed-domain": { type: "string", multiple: true },
        "blocked-domain": { type: "string", multiple: true },
        "context-size": { type: "string" },
        "web-access": { type: "string" },
        country: { type: "string" },
        region: { type: "string" },
        city: { type: "string" },
        timezone: { type: "string" },
        "image-max-results": { type: "string" },
        "image-caption": { type: "boolean" },
        "no-image-caption": { type: "boolean" },
        ref: { type: "string", multiple: true },
        lineno: { type: "string" },
        pattern: { type: "string" },
        "link-id": { type: "string" },
        ticker: { type: "string" },
        "asset-type": { type: "string" },
        market: { type: "string" },
        location: { type: "string" },
        start: { type: "string" },
        duration: { type: "string" },
        "sports-fn": { type: "string" },
        league: { type: "string" },
        team: { type: "string" },
        opponent: { type: "string" },
        "date-from": { type: "string" },
        "date-to": { type: "string" },
        "num-games": { type: "string" },
        locale: { type: "string" },
        "utc-offset": { type: "string" },
        "commands-json": { type: "string" },
        "commands-file": { type: "string" },
        "payload-file": { type: "string" },
      },
    })
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error))
  }

  if (parsed.values.help) {
    return { help: true, command, values: parsed.values }
  }

  // Allow positional query shortcut for `search "my query"`
  if (parsed.positionals.length > 0) {
    if (command === "search") {
      parsed.values.query = [
        ...(parsed.values.query ?? []),
        ...parsed.positionals,
      ]
    } else if (command === "open") {
      parsed.values.ref = [...(parsed.values.ref ?? []), ...parsed.positionals]
    } else {
      throw new CliError(
        `Unexpected positional argument(s) for ${command}: ${parsed.positionals.join(" ")}`,
      )
    }
  }

  return { help: false, command, values: parsed.values }
}

/**
 * @param {Record<string, unknown>} values
 * @returns {Record<string, unknown> | undefined}
 */
function buildSettings(values) {
  /** @type {Record<string, unknown>} */
  const settings = {}
  const contextSize = validateChoice(
    /** @type {string | undefined} */ (values["context-size"]),
    CONTEXT_SIZES,
    "--context-size",
  )
  if (contextSize) settings.search_context_size = contextSize

  const webAccess = parseWebAccess(
    /** @type {string | undefined} */ (values["web-access"]),
  )
  if (webAccess !== undefined) settings.external_web_access = webAccess

  const allowedDomains = /** @type {string[] | undefined} */ (
    values["allowed-domain"]
  )
    ?.map((item) => item.trim())
    .filter(Boolean)
  const blockedDomains = /** @type {string[] | undefined} */ (
    values["blocked-domain"]
  )
    ?.map((item) => item.trim())
    .filter(Boolean)
  if (allowedDomains?.length || blockedDomains?.length) {
    settings.filters = {
      ...(allowedDomains?.length ? { allowed_domains: allowedDomains } : {}),
      ...(blockedDomains?.length ? { blocked_domains: blockedDomains } : {}),
    }
  }

  const locationFields = {
    ...(values.country ? { country: String(values.country).trim() } : {}),
    ...(values.region ? { region: String(values.region).trim() } : {}),
    ...(values.city ? { city: String(values.city).trim() } : {}),
    ...(values.timezone ? { timezone: String(values.timezone).trim() } : {}),
  }
  if (Object.keys(locationFields).length > 0) {
    settings.user_location = { type: "approximate", ...locationFields }
  }

  if (values["image-caption"] && values["no-image-caption"]) {
    throw new CliError(
      "Do not pass both --image-caption and --no-image-caption.",
    )
  }
  /** @type {Record<string, unknown>} */
  const imageSettings = {}
  if (values["image-max-results"] !== undefined) {
    imageSettings.max_results = parseIntOption(
      String(values["image-max-results"]),
      "--image-max-results",
      1,
    )
  }
  if (values["image-caption"]) imageSettings.caption = true
  if (values["no-image-caption"]) imageSettings.caption = false
  if (Object.keys(imageSettings).length > 0) {
    settings.image_settings = imageSettings
  }

  return Object.keys(settings).length > 0 ? settings : undefined
}

/**
 * @param {string} command
 * @param {Record<string, unknown>} values
 * @param {string} sessionId
 * @returns {Promise<Record<string, unknown>>}
 */
export async function buildAlphaSearchPayload(command, values, sessionId) {
  const model =
    typeof values.model === "string" && values.model.trim() ?
      values.model.trim()
    : DEFAULT_MODEL

  const responseLength = validateChoice(
    /** @type {string | undefined} */ (values["response-length"]),
    RESPONSE_LENGTHS,
    "--response-length",
  )

  const maxOutputTokens =
    values["max-output-tokens"] !== undefined ?
      parseIntOption(
        String(values["max-output-tokens"]),
        "--max-output-tokens",
        1,
      )
    : undefined

  /** @type {Record<string, unknown>} */
  const reasoning = {}
  if (typeof values["reasoning-effort"] === "string") {
    const effort = values["reasoning-effort"].trim()
    if (!effort) throw new CliError("--reasoning-effort must not be empty")
    reasoning.effort = effort
  }
  const reasoningSummary = validateChoice(
    /** @type {string | undefined} */ (values["reasoning-summary"]),
    REASONING_SUMMARIES,
    "--reasoning-summary",
  )
  if (reasoningSummary) reasoning.summary = reasoningSummary

  const settings = buildSettings(values)

  if (command === "raw") {
    const rawSources = [
      values["commands-json"],
      values["commands-file"],
      values["payload-file"],
    ].filter((item) => item !== undefined)
    if (rawSources.length !== 1) {
      throw new CliError(
        "raw requires exactly one of --commands-json, --commands-file, or --payload-file.",
      )
    }

    if (typeof values["payload-file"] === "string") {
      const content = await readFile(values["payload-file"], "utf8")
      let parsed
      try {
        parsed = JSON.parse(content)
      } catch (error) {
        throw new CliError(
          `Invalid JSON in --payload-file: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const record = asRecord(parsed)
      if (Object.keys(record).length === 0) {
        throw new CliError("--payload-file must contain a JSON object.")
      }
      const fileId =
        typeof record.id === "string" && record.id.trim() ?
          record.id.trim()
        : sessionId
      const fileModel =
        typeof record.model === "string" && record.model.trim() ?
          record.model.trim()
        : model
      return {
        ...record,
        id: values["session-id"] ? sessionId : fileId,
        model: values.model ? model : fileModel,
      }
    }

    const rawText =
      typeof values["commands-file"] === "string" ?
        await readFile(values["commands-file"], "utf8")
      : String(values["commands-json"])
    let commands
    try {
      commands = JSON.parse(rawText)
    } catch (error) {
      throw new CliError(
        `Invalid commands JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (
      commands === null
      || typeof commands !== "object"
      || Array.isArray(commands)
    ) {
      throw new CliError("Commands JSON must be an object.")
    }
    const mergedCommands = {
      .../** @type {Record<string, unknown>} */ (commands),
      ...(responseLength ? { response_length: responseLength } : {}),
    }
    return {
      id: sessionId,
      model,
      commands: mergedCommands,
      ...(settings ? { settings } : {}),
      ...(Object.keys(reasoning).length > 0 ? { reasoning } : {}),
      ...(maxOutputTokens !== undefined ?
        { max_output_tokens: maxOutputTokens }
      : {}),
    }
  }

  /** @type {Record<string, unknown>} */
  const commands = {}

  if (command === "search") {
    const queries = /** @type {string[] | undefined} */ (values.query ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
    const imageQueries = /** @type {string[] | undefined} */ (
      values["image-query"] ?? []
    )
      .map((item) => item.trim())
      .filter(Boolean)
    if (queries.length === 0 && imageQueries.length === 0) {
      throw new CliError(
        "search requires at least one --query (or --image-query).",
      )
    }
    const recency =
      values.recency !== undefined ?
        parseIntOption(String(values.recency), "--recency", 0)
      : undefined
    const domains = /** @type {string[] | undefined} */ (values.domain ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
    const queryExtras = {
      ...(recency !== undefined ? { recency } : {}),
      ...(domains.length > 0 ? { domains } : {}),
    }
    if (queries.length > 0) {
      commands.search_query = queries.map((q) => ({ q, ...queryExtras }))
    }
    if (imageQueries.length > 0) {
      commands.image_query = imageQueries.map((q) => ({ q, ...queryExtras }))
    }
  } else if (command === "open") {
    const refs = /** @type {string[] | undefined} */ (values.ref ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
    if (refs.length === 0) {
      throw new CliError("open requires at least one --ref (URL or ref_id).")
    }
    const lineno =
      values.lineno !== undefined ?
        parseIntOption(String(values.lineno), "--lineno", 0)
      : undefined
    commands.open = refs.map((ref_id) => ({
      ref_id,
      ...(lineno !== undefined ? { lineno } : {}),
    }))
  } else if (command === "find") {
    const refs = /** @type {string[] | undefined} */ (values.ref ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
    const pattern =
      typeof values.pattern === "string" ? values.pattern.trim() : ""
    if (refs.length === 0 || !pattern) {
      throw new CliError("find requires --ref and --pattern.")
    }
    commands.find = refs.map((ref_id) => ({ ref_id, pattern }))
  } else if (command === "click") {
    const refs = /** @type {string[] | undefined} */ (values.ref ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
    if (refs.length !== 1 || values["link-id"] === undefined) {
      throw new CliError("click requires a single --ref and --link-id.")
    }
    const linkId = parseIntOption(String(values["link-id"]), "--link-id", 0)
    commands.click = [{ ref_id: refs[0], id: linkId }]
  } else if (command === "structured") {
    if (values.ticker !== undefined) {
      const ticker = String(values.ticker).trim()
      const assetType = validateChoice(
        /** @type {string | undefined} */ (values["asset-type"]),
        FINANCE_TYPES,
        "--asset-type",
      )
      if (!ticker || !assetType) {
        throw new CliError("Finance lookup requires --ticker and --asset-type.")
      }
      commands.finance = [
        {
          ticker,
          type: assetType,
          ...(values.market ? { market: String(values.market).trim() } : {}),
        },
      ]
    }
    if (values.location !== undefined) {
      const location = String(values.location).trim()
      if (!location) throw new CliError("--location must not be empty.")
      commands.weather = [
        {
          location,
          ...(values.start ? { start: String(values.start).trim() } : {}),
          ...(values.duration !== undefined ?
            { duration: parseIntOption(String(values.duration), "--duration") }
          : {}),
        },
      ]
    }
    if (values["sports-fn"] !== undefined || values.league !== undefined) {
      const fn = validateChoice(
        /** @type {string | undefined} */ (values["sports-fn"]),
        SPORTS_FNS,
        "--sports-fn",
      )
      const league = validateChoice(
        /** @type {string | undefined} */ (values.league),
        SPORTS_LEAGUES,
        "--league",
      )
      if (!fn || !league) {
        throw new CliError("Sports lookup requires --sports-fn and --league.")
      }
      commands.sports = [
        {
          tool: "sports",
          fn,
          league,
          ...(values.team ? { team: String(values.team).trim() } : {}),
          ...(values.opponent ?
            { opponent: String(values.opponent).trim() }
          : {}),
          ...(values["date-from"] ?
            { date_from: String(values["date-from"]).trim() }
          : {}),
          ...(values["date-to"] ?
            { date_to: String(values["date-to"]).trim() }
          : {}),
          ...(values["num-games"] !== undefined ?
            {
              num_games: parseIntOption(
                String(values["num-games"]),
                "--num-games",
              ),
            }
          : {}),
          ...(values.locale ? { locale: String(values.locale).trim() } : {}),
        },
      ]
    }
    if (values["utc-offset"] !== undefined) {
      const offset = String(values["utc-offset"]).trim()
      if (!UTC_OFFSET_PATTERN.test(offset)) {
        throw new CliError(
          `--utc-offset must match ±HH:MM (e.g. +08:00, -07:00), got "${offset}"`,
        )
      }
      commands.time = [{ utc_offset: offset }]
    }
    if (Object.keys(commands).length === 0) {
      throw new CliError(
        "structured requires at least one of --ticker/--asset-type, --location, --sports-fn/--league, or --utc-offset.",
      )
    }
  }

  if (responseLength) {
    commands.response_length = responseLength
  }

  return {
    id: sessionId,
    model,
    commands,
    ...(settings ? { settings } : {}),
    ...(Object.keys(reasoning).length > 0 ? { reasoning } : {}),
    ...(maxOutputTokens !== undefined ?
      { max_output_tokens: maxOutputTokens }
    : {}),
  }
}

/**
 * @param {string} sessionId
 * @param {Record<string, unknown>} response
 * @param {"text" | "json"} format
 * @returns {string}
 */
export function formatAlphaSearchOutput(sessionId, response, format) {
  if (format === "json") {
    return `${JSON.stringify({ session_id: sessionId, ...response }, null, 2)}\n`
  }

  const lines = [`Session ID: ${sessionId}`]
  if (typeof response.output === "string" && response.output.trim()) {
    lines.push("", response.output.trim())
  }

  const results = Array.isArray(response.results) ? response.results : []
  if (results.length > 0) {
    lines.push("", "Results:")
    for (const entry of results) {
      const item = asRecord(entry)
      const refId =
        typeof item.ref_id === "string" && item.ref_id ?
          `[${item.ref_id}] `
        : ""
      const title =
        typeof item.title === "string" && item.title.trim() ? item.title.trim()
        : typeof item.url === "string" ? item.url
        : "(untitled)"
      const url = typeof item.url === "string" ? item.url : ""
      const snippet =
        typeof item.snippet === "string" && item.snippet.trim() ?
          item.snippet.trim()
        : ""
      lines.push(`- ${refId}${title}${url ? ` — ${url}` : ""}`)
      if (snippet && snippet !== title && snippet !== url) {
        lines.push(`  ${snippet}`)
      }
    }
  }

  if (lines.length === 1) {
    lines.push("", JSON.stringify(response, null, 2))
  }

  return `${lines.join("\n")}\n`
}

/**
 * @param {string[]} argv
 * @param {CliDeps} [deps={}]
 * @returns {Promise<AlphaSearchRunResult | null>}
 */
export async function runAlphaSearch(argv, deps = {}) {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const stdout = deps.stdout ?? ((text) => process.stdout.write(text))
  const stderr = deps.stderr ?? ((text) => process.stderr.write(text))
  const sleep =
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const uuid = deps.uuid ?? randomUUID

  const parsed = parseCliArgs(argv)
  if (parsed.help) {
    stdout(usageText())
    return null
  }

  const { command, values } = parsed
  const format = /** @type {"text" | "json"} */ (
    validateChoice(
      /** @type {string | undefined} */ (values.format),
      OUTPUT_FORMATS,
      "--format",
    ) ?? "text"
  )
  const provider = validateProvider(
    /** @type {string | undefined} */ (values.provider),
  )
  const baseUrl = normalizeBaseUrl(
    /** @type {string | undefined} */ (values["base-url"])
      ?? env.COPILOT_API_BASE_URL,
  )
  const endpoint = buildEndpointUrl(baseUrl, provider)
  const timeoutMs =
    values["timeout-ms"] !== undefined ?
      parseIntOption(String(values["timeout-ms"]), "--timeout-ms", 1000)
    : DEFAULT_TIMEOUT_MS
  const maxAttempts =
    values["max-attempts"] !== undefined ?
      parseIntOption(String(values["max-attempts"]), "--max-attempts", 1, 10)
    : DEFAULT_MAX_ATTEMPTS
  const dryRun = Boolean(values["dry-run"])
  const apiKey = (env.GITHUB_COPILOT_API_KEY ?? "").trim() || undefined

  const sessionId =
    typeof values["session-id"] === "string" && values["session-id"].trim() ?
      values["session-id"].trim()
    : `alpha-search-${uuid()}`

  const payload = await buildAlphaSearchPayload(command, values, sessionId)
  const resolvedSessionId =
    typeof payload.id === "string" && payload.id.trim() ? payload.id : sessionId

  if (!apiKey) {
    if (dryRun) {
      stderr(
        "Warning: GITHUB_COPILOT_API_KEY is not set; dry-run preview only.\n",
      )
    } else if (!isLoopbackUrl(baseUrl)) {
      throw new CliError(
        `GITHUB_COPILOT_API_KEY is not set for non-loopback gateway ${baseUrl}. Export GITHUB_COPILOT_API_KEY before running.`,
      )
    } else {
      stderr(
        "Note: GITHUB_COPILOT_API_KEY is not set; sending unauthenticated request to loopback gateway.\n",
      )
    }
  }

  if (dryRun) {
    const preview = {
      dry_run: true,
      endpoint,
      auth:
        apiKey ?
          "Bearer [REDACTED] (from GITHUB_COPILOT_API_KEY)"
        : "none (GITHUB_COPILOT_API_KEY unset)",
      session_id: resolvedSessionId,
      payload,
      ...(values.out ? { out: String(values.out) } : {}),
    }
    stdout(`${JSON.stringify(preview, null, 2)}\n`)
    return {
      endpoint,
      sessionId: resolvedSessionId,
      payload,
      dryRun: true,
      outPath: values.out ? String(values.out) : undefined,
    }
  }

  const outPath =
    typeof values.out === "string" && values.out.trim() ?
      values.out.trim()
    : undefined
  if (outPath && existsSync(outPath) && !values.force) {
    throw new CliError(
      `Output already exists: ${outPath} (pass --force to overwrite)`,
    )
  }

  const headers = buildRequestHeaders(resolvedSessionId, apiKey)
  const body = JSON.stringify(payload)

  let lastError
  let responseJson
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })

      const text = await response.text()
      let parsedBody
      try {
        parsedBody = text ? JSON.parse(text) : {}
      } catch {
        parsedBody = { raw: text }
      }

      if (!response.ok) {
        if (RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts) {
          const delayMs =
            parseRetryAfterMs(response)
            ?? Math.min(1000 * 2 ** (attempt - 1), 15_000)
          stderr(
            `Gateway returned HTTP ${response.status} (attempt ${attempt}/${maxAttempts}); retrying in ${delayMs}ms...\n`,
          )
          await sleep(delayMs)
          continue
        }
        const detail =
          extractErrorMessage(parsedBody) ?? text.slice(0, 400).trim()
        const authHint =
          (response.status === 401 || response.status === 403) && !apiKey ?
            " Set GITHUB_COPILOT_API_KEY to a valid gateway API key."
          : ""
        throw new CliError(
          `Alpha search failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}.${authHint}`,
        )
      }

      responseJson = asRecord(parsedBody)
      break
    } catch (error) {
      if (error instanceof CliError) throw error
      lastError = error
      if (attempt < maxAttempts) {
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 15_000)
        stderr(
          `Network error on attempt ${attempt}/${maxAttempts} (${error instanceof Error ? error.message : String(error)}); retrying in ${delayMs}ms...\n`,
        )
        await sleep(delayMs)
        continue
      }
      throw new CliError(
        `Alpha search request failed after ${maxAttempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      )
    }
  }

  const finalResponse = responseJson ?? {}
  const formatted = formatAlphaSearchOutput(
    resolvedSessionId,
    finalResponse,
    format,
  )

  if (typeof values.out === "string" && values.out.trim()) {
    const outPath = values.out.trim()
    await writeFileAtomic(outPath, formatted, Boolean(values.force))
    stderr(`Wrote ${outPath}\n`)
  }

  stdout(formatted)
  return {
    endpoint,
    sessionId: resolvedSessionId,
    payload,
    response: finalResponse,
    dryRun: false,
    outPath: typeof values.out === "string" ? values.out.trim() : undefined,
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
  runAlphaSearch(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Error: ${message}\n`)
    process.exitCode = error instanceof CliError ? error.exitCode : 1
  })
}
