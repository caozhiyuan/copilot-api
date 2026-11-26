import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildAlphaSearchPayload,
  buildEndpointUrl,
  CliError,
  formatAlphaSearchOutput,
  isLoopbackUrl,
  normalizeBaseUrl,
  runAlphaSearch,
} from "../.agents/skills/copilot-api-web-search/scripts/web_search.mjs"
import { alphaSearchRouteDependencies } from "~/routes/alpha-search/route"
import { createServer } from "~/server"

const originalAlphaRouteDeps = { ...alphaSearchRouteDependencies }
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-skill-web-search-"))
})

afterEach(async () => {
  Object.assign(alphaSearchRouteDependencies, originalAlphaRouteDeps)
  await fs.promises.rm(tempDir, { recursive: true, force: true })
})

describe("copilot-api-web-search helpers", () => {
  test("normalizes base URLs and detects loopback hosts", () => {
    expect(normalizeBaseUrl(undefined)).toBe("http://localhost:4141")
    expect(normalizeBaseUrl("http://127.0.0.1:4141/")).toBe(
      "http://127.0.0.1:4141",
    )
    expect(normalizeBaseUrl("https://gw.example.com/proxy/v1/")).toBe(
      "https://gw.example.com/proxy",
    )
    expect(isLoopbackUrl("http://localhost:4141")).toBe(true)
    expect(isLoopbackUrl("http://127.0.0.1:4141")).toBe(true)
    expect(isLoopbackUrl("http://[::1]:4141")).toBe(true)
    expect(isLoopbackUrl("https://gw.example.com")).toBe(false)

    expect(() => normalizeBaseUrl("ftp://localhost:4141")).toThrow(CliError)
    expect(() => normalizeBaseUrl("http://user:pass@localhost:4141")).toThrow(
      CliError,
    )
    expect(() => normalizeBaseUrl("not-a-url")).toThrow(CliError)
  })

  test("builds top-level and provider-scoped endpoints", () => {
    expect(buildEndpointUrl("http://localhost:4141", undefined)).toBe(
      "http://localhost:4141/v1/alpha/search",
    )
    expect(buildEndpointUrl("http://localhost:4141", "deepseek")).toBe(
      "http://localhost:4141/deepseek/v1/alpha/search",
    )
  })

  test("formats text, empty fallback, and json outputs cleanly", () => {
    const text = formatAlphaSearchOutput(
      "sess-1",
      {
        output: "Grounded summary",
        results: [
          {
            type: "text_result",
            ref_id: "turn0search0",
            title: "Docs",
            url: "https://example.com/docs",
            snippet: "Useful snippet",
          },
        ],
      },
      "text",
    )
    expect(text).toContain("Session ID: sess-1")
    expect(text).toContain("Grounded summary")
    expect(text).toContain("[turn0search0] Docs — https://example.com/docs")
    expect(text).toContain("Useful snippet")

    const emptyText = formatAlphaSearchOutput(
      "sess-empty",
      { custom: 1 },
      "text",
    )
    expect(emptyText).toContain('"custom": 1')

    const jsonText = formatAlphaSearchOutput(
      "sess-1",
      { output: "ok", results: [] },
      "json",
    )
    expect(JSON.parse(jsonText)).toEqual({
      session_id: "sess-1",
      output: "ok",
      results: [],
    })
  })
})

describe("copilot-api-web-search CLI", () => {
  test("prints help text and returns null", async () => {
    let out = ""
    const result = await runAlphaSearch(["--help"], {
      stdout: (chunk) => {
        out += chunk
      },
    })
    expect(result).toBeNull()
    expect(out).toContain("GITHUB_COPILOT_API_KEY")
    expect(out).toContain("COPILOT_API_BASE_URL")
  })

  test("supports dry-run with redacted key and full search options", async () => {
    let out = ""
    let err = ""
    const result = await runAlphaSearch(
      [
        "search",
        "--query",
        "Bun 1.4",
        "--query",
        "Node 22",
        "--image-query",
        "bun logo",
        "--recency",
        "7",
        "--domain",
        "bun.sh",
        "--allowed-domain",
        "bun.sh",
        "--blocked-domain",
        "spam.example",
        "--context-size",
        "high",
        "--web-access",
        "live",
        "--country",
        "US",
        "--city",
        "San Francisco",
        "--timezone",
        "America/Los_Angeles",
        "--image-max-results",
        "4",
        "--image-caption",
        "--response-length",
        "short",
        "--reasoning-effort",
        "low",
        "--reasoning-summary",
        "concise",
        "--max-output-tokens",
        "2048",
        "--session-id",
        "fixed-sess",
        "--dry-run",
      ],
      {
        env: {
          GITHUB_COPILOT_API_KEY: "super-secret-gateway-key",
          COPILOT_API_BASE_URL: "http://127.0.0.1:4141/v1",
        },
        stdout: (chunk) => {
          out += chunk
        },
        stderr: (chunk) => {
          err += chunk
        },
      },
    )

    expect(result?.dryRun).toBe(true)
    expect(result?.endpoint).toBe("http://127.0.0.1:4141/v1/alpha/search")
    expect(out).not.toContain("super-secret-gateway-key")
    expect(err).not.toContain("super-secret-gateway-key")
    const preview = JSON.parse(out) as {
      auth: string
      payload: Record<string, unknown>
    }
    expect(preview.auth).toContain("[REDACTED]")
    expect(preview.payload).toMatchObject({
      id: "fixed-sess",
      model: "gpt-6-luna",
      max_output_tokens: 2048,
      reasoning: { effort: "low", summary: "concise" },
      commands: {
        search_query: [
          { q: "Bun 1.4", recency: 7, domains: ["bun.sh"] },
          { q: "Node 22", recency: 7, domains: ["bun.sh"] },
        ],
        image_query: [{ q: "bun logo", recency: 7, domains: ["bun.sh"] }],
        response_length: "short",
      },
      settings: {
        search_context_size: "high",
        external_web_access: "live",
        filters: {
          allowed_domains: ["bun.sh"],
          blocked_domains: ["spam.example"],
        },
        user_location: {
          type: "approximate",
          country: "US",
          city: "San Francisco",
          timezone: "America/Los_Angeles",
        },
        image_settings: { max_results: 4, caption: true },
      },
    })
  })

  test("builds open, find, click, structured, and raw payloads", async () => {
    const openPayload = await buildAlphaSearchPayload(
      "open",
      { ref: ["turn0search0", "https://example.com"], lineno: "12" },
      "s1",
    )
    expect(openPayload.commands).toEqual({
      open: [
        { ref_id: "turn0search0", lineno: 12 },
        { ref_id: "https://example.com", lineno: 12 },
      ],
    })

    const findPayload = await buildAlphaSearchPayload(
      "find",
      { ref: ["turn0view0"], pattern: "onError" },
      "s1",
    )
    expect(findPayload.commands).toEqual({
      find: [{ ref_id: "turn0view0", pattern: "onError" }],
    })

    const clickPayload = await buildAlphaSearchPayload(
      "click",
      { ref: ["turn0view0"], "link-id": "2" },
      "s1",
    )
    expect(clickPayload.commands).toEqual({
      click: [{ ref_id: "turn0view0", id: 2 }],
    })

    const structuredPayload = await buildAlphaSearchPayload(
      "structured",
      {
        ticker: "AAPL",
        "asset-type": "equity",
        market: "US",
        location: "Tokyo",
        start: "2026-11-25",
        duration: "3",
        "sports-fn": "schedule",
        league: "nba",
        team: "Lakers",
        "num-games": "5",
        "utc-offset": "+08:00",
      },
      "s1",
    )
    expect(structuredPayload.commands).toEqual({
      finance: [{ ticker: "AAPL", type: "equity", market: "US" }],
      weather: [{ location: "Tokyo", start: "2026-11-25", duration: 3 }],
      sports: [
        {
          tool: "sports",
          fn: "schedule",
          league: "nba",
          team: "Lakers",
          num_games: 5,
        },
      ],
      time: [{ utc_offset: "+08:00" }],
    })

    const rawCommandsPath = path.join(tempDir, "commands.json")
    fs.writeFileSync(
      rawCommandsPath,
      JSON.stringify({ time: [{ utc_offset: "+00:00" }] }),
    )
    const rawFromCommands = await buildAlphaSearchPayload(
      "raw",
      { "commands-file": rawCommandsPath, "response-length": "short" },
      "s2",
    )
    expect(rawFromCommands).toMatchObject({
      id: "s2",
      commands: { time: [{ utc_offset: "+00:00" }], response_length: "short" },
    })

    const payloadPath = path.join(tempDir, "payload.json")
    fs.writeFileSync(
      payloadPath,
      JSON.stringify({
        id: "from-file",
        model: "deepseek/deepseek-flash",
        commands: { search_query: [{ q: "hello" }] },
      }),
    )
    const rawFromPayload = await buildAlphaSearchPayload(
      "raw",
      { "payload-file": payloadPath },
      "ignored",
    )
    expect(rawFromPayload).toMatchObject({
      id: "from-file",
      model: "deepseek/deepseek-flash",
    })
  })

  test("rejects invalid arguments and missing API key on non-loopback gateways", async () => {
    await expectReject(runAlphaSearch(["unknown"]), CliError)
    await expectReject(runAlphaSearch(["search"]), CliError)
    await expectReject(runAlphaSearch(["open"]), CliError)
    await expectReject(
      runAlphaSearch(["find", "--ref", "turn0view0"]),
      CliError,
    )
    await expectReject(
      runAlphaSearch(["click", "--ref", "turn0view0"]),
      CliError,
    )
    await expectReject(
      runAlphaSearch(["structured", "--utc-offset", "bad"]),
      CliError,
    )
    await expectReject(
      runAlphaSearch(["search", "--query", "x", "--provider", "../etc"]),
      CliError,
    )
    await expectReject(
      runAlphaSearch(
        ["search", "--query", "x", "--image-caption", "--no-image-caption"],
        { env: {} },
      ),
      CliError,
    )
    await expectReject(
      runAlphaSearch(
        ["search", "--query", "x", "--base-url", "https://gw.example.com"],
        { env: {} },
      ),
      /GITHUB_COPILOT_API_KEY/u,
    )
  })

  test("retries transient HTTP 429 and network errors, then saves output atomically", async () => {
    let calls = 0
    const sleeps: number[] = []
    const seenHeaders: Array<Headers> = []
    const mockFetch = (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      calls += 1
      seenHeaders.push(new Headers(init?.headers))
      if (calls === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "retry-after": "1" },
          }),
        )
      }
      if (calls === 2) {
        return Promise.reject(new Error("socket hang up"))
      }
      return Promise.resolve(
        Response.json({
          encrypted_output: null,
          output: "Search answer",
          results: [
            {
              type: "text_result",
              domain: "example.com",
              ref_id: "turn0search0",
              snippet: "Snippet",
              title: "Example",
              url: "https://example.com",
            },
          ],
        }),
      )
    }

    const outPath = path.join(tempDir, "nested", "result.txt")
    let out = ""
    const res = await runAlphaSearch(
      [
        "search",
        "positional query",
        "--session-id",
        "sess-retry",
        "--out",
        outPath,
      ],
      {
        env: { GITHUB_COPILOT_API_KEY: "gw-key-123" },
        fetch: mockFetch,
        sleep: (ms) => {
          sleeps.push(ms)
          return Promise.resolve()
        },
        stdout: (chunk) => {
          out += chunk
        },
        stderr: () => {},
      },
    )

    expect(calls).toBe(3)
    expect(sleeps).toEqual([1000, 2000])
    expect(seenHeaders[0]?.get("authorization")).toBe("Bearer gw-key-123")
    expect(seenHeaders[0]?.get("x-codex-turn-metadata")).toBe(
      JSON.stringify({ session_id: "sess-retry" }),
    )
    expect(res?.response?.output).toBe("Search answer")
    expect(fs.readFileSync(outPath, "utf8")).toBe(out)

    await expectReject(
      runAlphaSearch(["search", "--query", "again", "--out", outPath], {
        env: { GITHUB_COPILOT_API_KEY: "gw-key-123" },
        fetch: mockFetch,
        sleep: () => Promise.resolve(),
        stdout: () => {},
        stderr: () => {},
      }),
      /already exists/u,
    )
  })

  test("reports auth hint on HTTP 401 when loopback key is unset", async () => {
    const mockFetch = () =>
      Promise.resolve(
        Response.json({ error: { message: "Unauthorized" } }, { status: 401 }),
      )

    await expectReject(
      runAlphaSearch(["search", "--query", "test"], {
        env: {},
        fetch: mockFetch,
        stdout: () => {},
        stderr: () => {},
      }),
      /Set GITHUB_COPILOT_API_KEY/u,
    )
  })

  test("integrates end-to-end with copilot-api createServer() auth and alpha-search route", async () => {
    alphaSearchRouteDependencies.isAlphaSearchCodexPriorityEnabled = () => false
    alphaSearchRouteDependencies.resolveProviderConfig = () =>
      Promise.resolve(null)

    const server = createServer({ getApiKeys: () => ["gateway-alpha-key"] })
    const localFetch = (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const parsed = new URL(fetchUrl(input))
      return Promise.resolve(
        server.request(`${parsed.pathname}${parsed.search}`, init),
      )
    }

    let stdoutText = ""
    const res = await runAlphaSearch(
      [
        "structured",
        "--utc-offset",
        "+08:00",
        "--session-id",
        "e2e-alpha",
        "--format",
        "json",
      ],
      {
        env: {
          GITHUB_COPILOT_API_KEY: "gateway-alpha-key",
          COPILOT_API_BASE_URL: "http://localhost:4141",
        },
        fetch: localFetch,
        stdout: (chunk) => {
          stdoutText += chunk
        },
        stderr: () => {},
      },
    )

    expect(res?.dryRun).toBe(false)
    const body = JSON.parse(stdoutText) as {
      session_id: string
      output: string
    }
    expect(body.session_id).toBe("e2e-alpha")
    expect(body.output).toContain("Time at UTC+08:00:")
  })

  test("handles space-separated negative --utc-offset, invalid --payload-file fields, and preflight --out check", async () => {
    let out = ""
    const negRes = await runAlphaSearch(
      ["structured", "--utc-offset", "-07:00", "--dry-run"],
      {
        env: { GITHUB_COPILOT_API_KEY: "gw-key" },
        stdout: (chunk) => {
          out += chunk
        },
        stderr: () => {},
      },
    )
    expect(negRes?.payload).toMatchObject({
      commands: { time: [{ utc_offset: "-07:00" }] },
    })
    expect(JSON.parse(out)).toMatchObject({
      payload: { commands: { time: [{ utc_offset: "-07:00" }] } },
    })

    const badFieldsPath = path.join(tempDir, "blank-fields.json")
    fs.writeFileSync(
      badFieldsPath,
      JSON.stringify({
        id: "   ",
        model: null,
        commands: { search_query: [{ q: "fallback test" }] },
      }),
    )
    const fallbackPayload = await buildAlphaSearchPayload(
      "raw",
      { "payload-file": badFieldsPath },
      "fallback-sess",
    )
    expect(fallbackPayload).toMatchObject({
      id: "fallback-sess",
      model: "gpt-6-luna",
    })

    const existingOut = path.join(tempDir, "existing.txt")
    fs.writeFileSync(existingOut, "keep")
    let fetchCalled = false
    await expectReject(
      runAlphaSearch(["search", "--query", "skip", "--out", existingOut], {
        env: { GITHUB_COPILOT_API_KEY: "gw-key" },
        fetch: () => {
          fetchCalled = true
          return Promise.resolve(Response.json({ output: "should not run" }))
        },
        stdout: () => {},
        stderr: () => {},
      }),
      /already exists/u,
    )
    expect(fetchCalled).toBe(false)
  })
})
