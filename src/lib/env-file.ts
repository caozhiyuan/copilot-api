import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"

import { PATHS } from "./paths"

type ShellName = "zsh" | "bash" | "sh"

const SOURCE_MARKER_START = "# >>> copilot-api (managed by --source-env) >>>"
const SOURCE_MARKER_END = "# <<< copilot-api (managed by --source-env) <<<"

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function shSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export interface EnvFileOptions {
  port: number
  model: string
  smallModel: string
  authToken: string
}

export function buildClaudeEnvVars(
  options: EnvFileOptions,
): Array<[string, string]> {
  const { port, model, smallModel, authToken } = options
  const baseUrl = `http://localhost:${port}`

  return [
    ["ANTHROPIC_BASE_URL", baseUrl],
    ["ANTHROPIC_AUTH_TOKEN", authToken],
    ["ANTHROPIC_MODEL", model],
    ["ANTHROPIC_DEFAULT_SONNET_MODEL", model],
    ["ANTHROPIC_DEFAULT_HAIKU_MODEL", smallModel],
    ["DISABLE_NON_ESSENTIAL_MODEL_CALLS", "1"],
    ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"],
    ["DISABLE_TELEMETRY", "1"],
    ["DISABLE_ERROR_REPORTING", "1"],
    ["DISABLE_BUG_COMMAND", "1"],
    ["DISABLE_AUTOUPDATER", "1"],
    ["CLAUDE_CODE_ATTRIBUTION_HEADER", "0"],
    ["CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION", "false"],
    ["CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "true"],
    ["CLAUDE_CODE_ENABLE_AWAY_SUMMARY", "0"],
    ["CLAUDE_PLUGIN_ENABLE_QUESTION_RULES", "true"],
  ]
}

export function buildEnvVars(options: EnvFileOptions): Array<[string, string]> {
  const { port, model, authToken } = options
  const baseUrl = `http://localhost:${port}`

  return [
    ...buildClaudeEnvVars(options),
    ["OPENAI_BASE_URL", `${baseUrl}/v1`],
    ["OPENAI_API_KEY", authToken],
    ["OPENAI_MODEL", model],
  ]
}

export function formatDotenv(pairs: Array<[string, string]>): string {
  return (
    pairs.map(([key, value]) => `${key}=${shSingleQuote(value)}`).join("\n")
    + "\n"
  )
}

export async function writeEnvFile(
  options: EnvFileOptions,
  filePath: string = PATHS.ENV_FILE_PATH,
): Promise<string> {
  const contents = formatDotenv(buildEnvVars(options))
  // Create with 0600 up front so secrets are never briefly world-readable.
  await fs.writeFile(filePath, contents, { mode: 0o600 })
  // Re-assert mode in case the file pre-existed with broader permissions.
  await fs.chmod(filePath, 0o600)
  return filePath
}

function detectShell(): ShellName {
  const shell = process.env.SHELL ?? ""
  if (shell.endsWith("zsh")) return "zsh"
  if (shell.endsWith("bash")) return "bash"
  return "sh"
}

export function resolveShellRcPath(
  shell: ShellName = detectShell(),
  home: string = os.homedir(),
): string {
  switch (shell) {
    case "zsh": {
      return path.join(home, ".zshrc")
    }
    case "bash": {
      // macOS login shells read .bash_profile; prefer it when present.
      return path.join(home, ".bash_profile")
    }
    default: {
      return path.join(home, ".profile")
    }
  }
}

function buildSourceBlock(envFilePath: string): string {
  // POSIX shells (sh/bash/zsh): enable allexport only around the source call,
  // and restore the previous allexport state regardless of source success.
  const q = shSingleQuote(envFilePath)
  const body =
    `if [ -f ${q} ]; then\n`
    + `    case $- in *a*) __copilot_api_a=1 ;; *) __copilot_api_a=0 ;; esac\n`
    + `    set -a\n`
    + `    . ${q}\n`
    + `    [ "$__copilot_api_a" = 0 ] && set +a\n`
    + `    unset __copilot_api_a\n`
    + `fi`
  return `${SOURCE_MARKER_START}\n${body}\n${SOURCE_MARKER_END}\n`
}

export async function sourceEnvFileInShellRc(
  envFilePath: string = PATHS.ENV_FILE_PATH,
  rcPath: string = resolveShellRcPath(),
): Promise<{ rcPath: string; added: boolean }> {
  const block = buildSourceBlock(envFilePath)

  let existing = ""
  try {
    existing = await fs.readFile(rcPath, "utf8")
  } catch (error) {
    // Only a missing file is benign; surface permission/other errors.
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error
    }
  }

  if (existing.includes(SOURCE_MARKER_START)) {
    return { rcPath, added: false }
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
  await fs.mkdir(path.dirname(rcPath), { recursive: true })
  await fs.appendFile(rcPath, `${prefix}\n${block}`)
  return { rcPath, added: true }
}
