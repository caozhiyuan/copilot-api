import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { isMcpFastPath, MCP_SUBCOMMAND } from "~/lib/cli/fast-path"

describe("isMcpFastPath", () => {
  test("matches the exact mcp subcommand invocation", () => {
    expect(isMcpFastPath(["bun", "main.ts", MCP_SUBCOMMAND])).toBe(true)
  })

  test("ignores trailing args after the mcp subcommand", () => {
    expect(isMcpFastPath(["bun", "main.ts", "mcp", "--verbose"])).toBe(true)
  })

  test("keeps help requests on the regular CLI path", () => {
    expect(isMcpFastPath(["bun", "main.ts", "mcp", "--help"])).toBe(false)
    expect(isMcpFastPath(["bun", "main.ts", "mcp", "-h"])).toBe(false)
  })

  test("rejects other subcommands and near-miss names", () => {
    expect(isMcpFastPath(["bun", "main.ts", "start"])).toBe(false)
    expect(isMcpFastPath(["bun", "main.ts", "mcpx"])).toBe(false)
  })

  test("rejects global flags preceding the mcp subcommand", () => {
    expect(isMcpFastPath(["bun", "main.ts", "--api-home=/tmp/x", "mcp"])).toBe(
      false,
    )
  })

  test("rejects a missing subcommand", () => {
    expect(isMcpFastPath(["bun", "main.ts"])).toBe(false)
    expect(isMcpFastPath([])).toBe(false)
  })
})

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const apiHome = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-mcp-"))

const baseEnv = {
  ...process.env,
  NODE_ENV: "production",
  COPILOT_API_HOME: apiHome,
  COPILOT_API_OAUTH_APP: "",
  COPILOT_API_ENTERPRISE_URL: "",
}

afterAll(() => {
  fs.rmSync(apiHome, { recursive: true, force: true })
})

interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

const runCli = (args: Array<string>): CliResult => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "./src/main.ts", ...args],
    cwd,
    env: baseEnv,
    stdin: new Uint8Array(),
  })

  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  }
}

describe("mcp fast path CLI", () => {
  test("starts the MCP server directly and keeps stdout clean", () => {
    const result = runCli(["mcp"])

    expect(result.exitCode).toBe(0)
    // The stdio transport must not be polluted by CLI output.
    expect(result.stdout).toBe("")
  })

  test("still serves mcp through citty when global flags come first", () => {
    const result = runCli([`--api-home=${apiHome}`, "mcp"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("prints help for a direct mcp help request", () => {
    const result = runCli(["mcp", "--help"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("USAGE")
  })
})
