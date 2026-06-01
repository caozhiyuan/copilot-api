import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  buildEnvVars,
  formatDotenv,
  resolveShellRcPath,
  sourceEnvFileInShellRc,
  writeEnvFile,
} from "~/lib/env-file"

const baseOptions = {
  port: 4141,
  model: "gpt-5.4",
  smallModel: "gpt-5-mini",
  authToken: "dummy",
}

const toMap = (pairs: Array<[string, string]>): Record<string, string> =>
  Object.fromEntries(pairs)

test("buildEnvVars uses provided model values", () => {
  const env = toMap(buildEnvVars(baseOptions))
  expect(env.ANTHROPIC_MODEL).toBe("gpt-5.4")
  expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("gpt-5.4")
  expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("gpt-5-mini")
  expect(env.OPENAI_MODEL).toBe("gpt-5.4")
})

test("buildEnvVars reflects custom model values", () => {
  const env = toMap(
    buildEnvVars({
      ...baseOptions,
      model: "custom-primary",
      smallModel: "custom-small",
    }),
  )
  expect(env.ANTHROPIC_MODEL).toBe("custom-primary")
  expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("custom-primary")
  expect(env.OPENAI_MODEL).toBe("custom-primary")
  expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("custom-small")
})

test("buildEnvVars derives base URLs from port", () => {
  const env = toMap(buildEnvVars({ ...baseOptions, port: 9999 }))
  expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:9999")
  expect(env.OPENAI_BASE_URL).toBe("http://localhost:9999/v1")
})

test("buildEnvVars propagates auth token to both keys", () => {
  const env = toMap(buildEnvVars({ ...baseOptions, authToken: "secret-key" }))
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("secret-key")
  expect(env.OPENAI_API_KEY).toBe("secret-key")
})

test("buildEnvVars produces a stable ordered key list", () => {
  const keys = buildEnvVars(baseOptions).map(([key]) => key)
  expect(keys).toEqual([
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "DISABLE_TELEMETRY",
    "DISABLE_ERROR_REPORTING",
    "DISABLE_BUG_COMMAND",
    "DISABLE_AUTOUPDATER",
    "CLAUDE_CODE_ATTRIBUTION_HEADER",
    "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
    "CLAUDE_CODE_ENABLE_AWAY_SUMMARY",
    "CLAUDE_PLUGIN_ENABLE_QUESTION_RULES",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
  ])
})

test("formatDotenv single-quotes values with a trailing newline", () => {
  const out = formatDotenv([
    ["A", "1"],
    ["B", "2"],
  ])
  expect(out).toBe("A='1'\nB='2'\n")
})

test("formatDotenv escapes single quotes in values to stay injection-safe", () => {
  const out = formatDotenv([["OPENAI_API_KEY", "a'b$(whoami)`id`"]])
  expect(out).toBe("OPENAI_API_KEY='a'\\''b$(whoami)`id`'\n")
})

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-env-"))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

test("writeEnvFile creates the file with expected contents", async () => {
  const target = path.join(tmpDir, "copilot-api.env")
  const written = await writeEnvFile(baseOptions, target)
  expect(written).toBe(target)
  const contents = await fs.readFile(target, "utf8")
  expect(contents).toBe(formatDotenv(buildEnvVars(baseOptions)))
})

test("writeEnvFile overwrites existing content", async () => {
  const target = path.join(tmpDir, "copilot-api.env")
  await fs.writeFile(target, "STALE=1\n")
  await writeEnvFile(baseOptions, target)
  const contents = await fs.readFile(target, "utf8")
  expect(contents).not.toContain("STALE")
  expect(contents).toContain("ANTHROPIC_BASE_URL='http://localhost:4141'")
})

test("writeEnvFile applies 0600 permissions", async () => {
  if (process.platform === "win32") return
  const target = path.join(tmpDir, "copilot-api.env")
  await writeEnvFile(baseOptions, target)
  const stat = await fs.stat(target)
  expect(stat.mode & 0o777).toBe(0o600)
})

test("sourceEnvFileInShellRc appends a managed source block", async () => {
  const envPath = path.join(tmpDir, "copilot-api.env")
  const rcPath = path.join(tmpDir, ".zshrc")
  await fs.writeFile(rcPath, "export FOO=bar")

  const result = await sourceEnvFileInShellRc(envPath, rcPath)
  expect(result.added).toBe(true)
  expect(result.rcPath).toBe(rcPath)

  const rc = await fs.readFile(rcPath, "utf8")
  expect(rc).toContain("export FOO=bar")
  expect(rc).toContain(`. '${envPath}'`)
  // allexport state is captured and restored around the source call.
  expect(rc).toContain("set -a")
  expect(rc).toContain("set +a")
})

test("sourceEnvFileInShellRc is idempotent via marker block", async () => {
  const envPath = path.join(tmpDir, "copilot-api.env")
  const rcPath = path.join(tmpDir, ".zshrc")

  const first = await sourceEnvFileInShellRc(envPath, rcPath)
  expect(first.added).toBe(true)

  const second = await sourceEnvFileInShellRc(envPath, rcPath)
  expect(second.added).toBe(false)

  const rc = await fs.readFile(rcPath, "utf8")
  const occurrences =
    rc.split("# >>> copilot-api (managed by --source-env) >>>").length - 1
  expect(occurrences).toBe(1)
})

test("sourceEnvFileInShellRc creates rc file and parent dirs when missing", async () => {
  const envPath = path.join(tmpDir, "copilot-api.env")
  const rcPath = path.join(tmpDir, "nested", ".bash_profile")

  const result = await sourceEnvFileInShellRc(envPath, rcPath)
  expect(result.added).toBe(true)
  const rc = await fs.readFile(rcPath, "utf8")
  expect(rc).toContain(`if [ -f '${envPath}' ]; then`)
  expect(rc).toContain(`. '${envPath}'`)
})

test("sourceEnvFileInShellRc surfaces non-ENOENT read errors", async () => {
  if (process.platform === "win32") return
  const envPath = path.join(tmpDir, "copilot-api.env")
  const rcPath = path.join(tmpDir, "unreadable.rc")
  await fs.writeFile(rcPath, "existing")
  await fs.chmod(rcPath, 0o000)

  let threw = false
  try {
    await sourceEnvFileInShellRc(envPath, rcPath)
  } catch {
    threw = true
  } finally {
    await fs.chmod(rcPath, 0o600)
  }
  // Root (e.g. in CI containers) can read 0o000 files, so only assert when
  // the permission actually blocked the read.
  if (process.getuid?.() !== 0) {
    expect(threw).toBe(true)
  }
})

test("resolveShellRcPath maps shells to their rc files", () => {
  const home = "/home/tester"
  expect(resolveShellRcPath("zsh", home)).toBe(`${home}/.zshrc`)
  expect(resolveShellRcPath("bash", home)).toBe(`${home}/.bash_profile`)
  expect(resolveShellRcPath("sh", home)).toBe(`${home}/.profile`)
})
