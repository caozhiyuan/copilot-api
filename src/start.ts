#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import { runProviderSetup } from "./auth"
import { listEnabledProviders, mergeConfigWithDefaults } from "./lib/config"
import {
  GITHUB_TOKEN_ENV,
  readGitHubToken,
  readGitHubTokenFromEnv,
} from "./lib/credential-store"
import { getLatestModelForFamily } from "./lib/models"
import { initOpencodeVersion } from "./lib/opencode"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import {
  getConfiguredApiKeys,
  getMissingApiKeysMessage,
} from "./lib/request-auth"
import { publishServerHealth } from "./lib/server-health"
import {
  DEFAULT_SERVER_HOST,
  formatServerUrl,
  resolveServerBinding,
} from "./lib/server-host"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { logUser, setupCopilotToken } from "./lib/token"
import { cacheModels } from "./services/copilot/models-cache"
import {
  cacheMacMachineId,
  cacheVSCodeVersion,
  cacheVsCodeSessionId,
  cacheVsCodeDeviceId,
} from "./services/vscode-env"

interface RunServerOptions {
  host: string
  port: number
  verbose: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
}

type GitHubTokenSource = "cli" | "env" | "file"

// The environment is preferred over the token file so the token never has to
// travel through the process list; --github-token stays first for callers that
// opt in explicitly.
async function resolveGitHubToken(
  cliToken: string | undefined,
): Promise<{ token: string; source: GitHubTokenSource } | null> {
  if (cliToken) return { token: cliToken, source: "cli" }

  const envToken = readGitHubTokenFromEnv()
  if (envToken) return { token: envToken, source: "env" }

  const fileToken = await readGitHubToken()
  if (fileToken) return { token: fileToken, source: "file" }

  return null
}

async function setupCopilotMode(
  githubToken: string,
  source: GitHubTokenSource,
  serverUrl: string,
  claudeCode: boolean,
): Promise<void> {
  state.githubToken = githubToken
  consola.info(
    source === "cli" ? "Using provided GitHub token"
    : source === "env" ?
      `Using GitHub token from the ${GITHUB_TOKEN_ENV} environment variable`
    : "Using GitHub token from local file",
  )

  await logUser()

  await cacheVSCodeVersion()
  cacheMacMachineId()
  cacheVsCodeSessionId()
  await cacheVsCodeDeviceId()

  await setupCopilotToken()
  await cacheModels()

  consola.info(
    `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
  )

  if (claudeCode) {
    runClaudeCode(serverUrl)
  }
}

function runClaudeCode(serverUrl: string): void {
  consola.log(
    "\n💡 Tip: The --claude-code flag simply generates a clipboard command for launching Claude Code. \n"
      + "All models remain fully accessible without this flag, just configure the model ID directly in your settings.json file.",
  )

  invariant(state.models, "Models should be loaded by now")

  // Default to the latest available model for each Claude Code size tier so
  // opus maps to opus, sonnet maps to sonnet, and haiku maps to haiku.
  const opusModel = getLatestModelForFamily("opus")?.id
  const sonnetModel = getLatestModelForFamily("sonnet")?.id
  const haikuModel = getLatestModelForFamily("haiku")?.id

  consola.info(
    "Selected default Claude Code models:\n"
      + `- Opus:   ${opusModel ?? "(none available)"}\n`
      + `- Sonnet: ${sonnetModel ?? "(none available)"}\n`
      + `- Haiku:  ${haikuModel ?? "(none available)"}`,
  )

  const command = generateEnvScript(
    {
      ANTHROPIC_BASE_URL: serverUrl,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: sonnetModel ?? opusModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
      CLAUDE_CODE_USE_VERTEX: "0",
      CLAUDE_CODE_USE_BEDROCK: "0",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "true",
      CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
      MCP_CONNECT_TIMEOUT_MS: "20000",
    },
    "claude",
  )

  try {
    clipboard.writeSync(command)
    consola.success("Copied Claude Code command to clipboard!")
  } catch {
    consola.warn(
      "Failed to copy to clipboard. Here is the Claude Code command:",
    )
    consola.log(command)
  }
}

async function setupProviderMode(
  serverUrl: string,
  claudeCode: boolean,
): Promise<void> {
  const enabledProviders = listEnabledProviders()

  if (enabledProviders.length > 0) {
    consola.info(`Using enabled providers: ${enabledProviders.join(", ")}`)
    return
  }

  consola.info("No enabled providers found. Setting one up...")
  await runProviderSetup()

  if (state.githubToken) {
    // The setup flow persisted the token with the credential store.
    await setupCopilotMode(state.githubToken, "file", serverUrl, claudeCode)
    return
  }

  const providersAfterSetup = listEnabledProviders()
  if (providersAfterSetup.length === 0) {
    throw new Error(
      "Failed to configure any provider. Run `copilot-api auth login` to set one up.",
    )
  }
  consola.info(`Configured providers: ${providersAfterSetup.join(", ")}`)
}

export async function runServer(options: RunServerOptions): Promise<void> {
  const tlsModule = await import("./lib/tls")
  tlsModule.enableSystemCACompat()

  consola.options.throttle = 0

  mergeConfigWithDefaults()

  const configuredApiKeys = getConfiguredApiKeys()
  const binding = resolveServerBinding(
    options.host,
    configuredApiKeys.length > 0,
  )

  const missingApiKeysMessage = getMissingApiKeysMessage()
  if (missingApiKeysMessage) {
    consola.info(missingApiKeysMessage)
  }

  await initOpencodeVersion()

  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  state.verbose = options.verbose
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.showToken = options.showToken

  await ensurePaths()

  const serverUrl = formatServerUrl(binding.clientHostname, options.port)

  const resolvedGitHubToken = await resolveGitHubToken(options.githubToken)
  if (resolvedGitHubToken) {
    await setupCopilotMode(
      resolvedGitHubToken.token,
      resolvedGitHubToken.source,
      serverUrl,
      options.claudeCode,
    )
  } else {
    await setupProviderMode(serverUrl, options.claudeCode)
  }

  consola.box(
    `🌐 Usage Viewer: ${serverUrl}/usage-viewer?endpoint=${serverUrl}/usage`,
  )

  const { createServer } = await import("./server")
  const server = createServer({ networkExposed: binding.networkExposed })

  const listener = serve({
    fetch: server.fetch as ServerHandler,
    hostname: binding.hostname,
    port: options.port,
    bun: {
      idleTimeout: 0,
    },
  })
  await publishServerHealth(listener)
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    host: {
      type: "string",
      default: process.env.HOST?.trim() || DEFAULT_SERVER_HOST,
      description: "Host to listen on",
    },
    port: {
      alias: "p",
      type: "string",
      default: process.env.PORT?.trim() || "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
  },
  run({ args }) {
    return runServer({
      host: args.host,
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
    })
  },
})
