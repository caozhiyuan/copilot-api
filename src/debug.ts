#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import { fileURLToPath } from "node:url"

import { getRawProviderConfig, listEnabledProviders } from "./lib/config"
import { PATHS } from "./lib/storage/paths"

interface DebugInfo {
  providers: {
    codexConfigured: boolean
    enabled: Array<string>
  }
  version: string
  runtime: {
    name: string
    version: string
    platform: string
    arch: string
  }
  paths: {
    APP_DIR: string
    CONFIG_PATH: string
    GITHUB_TOKEN_PATH: string
  }
  tokenExists: boolean
}

interface RunDebugOptions {
  json: boolean
}

async function getPackageVersion(): Promise<string> {
  try {
    const packageJsonPath = fileURLToPath(
      new URL("../package.json", import.meta.url),
    )
    // @ts-expect-error https://github.com/sindresorhus/eslint-plugin-unicorn/blob/v59.0.1/docs/rules/prefer-json-parse-buffer.md
    // JSON.parse() can actually parse buffers
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath)) as {
      version: string
    }
    return packageJson.version
  } catch {
    return "unknown"
  }
}

function getRuntimeInfo() {
  const isBun = typeof Bun !== "undefined"

  return {
    name: isBun ? "bun" : "node",
    version: isBun ? Bun.version : process.version.slice(1),
    platform: os.platform(),
    arch: os.arch(),
  }
}

async function checkFileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath)
    if (!stats.isFile()) return false

    const content = await fs.readFile(filePath, "utf8")
    return content.trim().length > 0
  } catch {
    return false
  }
}

async function getDebugInfo(): Promise<DebugInfo> {
  const [version, tokenExists] = await Promise.all([
    getPackageVersion(),
    checkFileExists(PATHS.GITHUB_TOKEN_PATH),
  ])

  return {
    providers: {
      codexConfigured: getRawProviderConfig("codex") !== null,
      enabled: listEnabledProviders(),
    },
    version,
    runtime: getRuntimeInfo(),
    paths: {
      APP_DIR: PATHS.APP_DIR,
      CONFIG_PATH: PATHS.CONFIG_PATH,
      GITHUB_TOKEN_PATH: PATHS.GITHUB_TOKEN_PATH,
    },
    tokenExists,
  }
}

function printDebugInfoPlain(info: DebugInfo): void {
  consola.info(`copilot-api debug

Version: ${info.version}
Runtime: ${info.runtime.name} ${info.runtime.version} (${info.runtime.platform} ${info.runtime.arch})

Providers:
- enabled: ${info.providers.enabled.join(", ") || "none"}
- codex configured: ${info.providers.codexConfigured ? "Yes" : "No"}

Paths:
- APP_DIR: ${info.paths.APP_DIR}
- CONFIG_PATH: ${info.paths.CONFIG_PATH}
- GITHUB_TOKEN_PATH: ${info.paths.GITHUB_TOKEN_PATH}

GitHub token exists: ${info.tokenExists ? "Yes" : "No"}`)
}

function printDebugInfoJson(info: DebugInfo): void {
  console.log(JSON.stringify(info, null, 2))
}

export async function runDebug(options: RunDebugOptions): Promise<void> {
  const debugInfo = await getDebugInfo()

  if (options.json) {
    printDebugInfoJson(debugInfo)
  } else {
    printDebugInfoPlain(debugInfo)
  }
}

export const debug = defineCommand({
  meta: {
    name: "debug",
    description: "Print debug information about the application",
  },
  args: {
    json: {
      type: "boolean",
      default: false,
      description: "Output debug information as JSON",
    },
  },
  run({ args }) {
    return runDebug({
      json: args.json,
    })
  },
})
