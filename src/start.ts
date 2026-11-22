#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import { setTimeout as delay } from "node:timers/promises"
import { serve, type ServerHandler } from "srvx"

import { runProviderSetup } from "./auth"
import { isGitHubCopilotEnabled } from "./lib/providers/github-copilot-provider"
import { listEnabledProviders, mergeConfigWithDefaults } from "./lib/config"
import { setupCopilotRuntime } from "~/lib/providers/copilot-runtime"
import {
  GITHUB_TOKEN_ENV,
  readGitHubToken,
  readGitHubTokenFromEnv,
} from "./lib/auth/credential-store"
import { startModelsDevCache } from "./lib/catalog/models-dev-cache"
import { initOpencodeVersion } from "./lib/providers/opencode"
import { ensurePaths, PATHS } from "./lib/storage/paths"
import { initProxyFromEnv } from "./lib/http/proxy"
import {
  getConfiguredApiKeys,
  getMissingApiKeysMessage,
} from "./lib/auth/request-auth"
import {
  DEFAULT_SERVER_HOST,
  formatServerUrl,
  resolveServerBinding,
} from "./lib/http/server-host"
import { state } from "./lib/state"
import { loadGatewayPlugins } from "./lib/plugins/gateway-plugins"
import {
  registerProcessCleanup,
  registerProcessShutdownDrain,
} from "./lib/process-cleanup"

interface RunServerOptions {
  host: string
  port: number
  verbose: boolean
  githubToken?: string
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
): Promise<void> {
  state.githubTokenSource = source
  consola.info(
    source === "cli" ? "Using provided GitHub token"
    : source === "env" ?
      `Using GitHub token from the ${GITHUB_TOKEN_ENV} environment variable`
    : "Using GitHub token from local file",
  )

  await setupCopilotRuntime(githubToken)
}

async function setupProviderMode(): Promise<void> {
  const enabledProviders = listEnabledProviders()

  if (enabledProviders.length > 0) {
    consola.info(`Using enabled providers: ${enabledProviders.join(", ")}`)
    return
  }

  if (!isGitHubCopilotEnabled()) {
    throw new Error(
      "No enabled providers found. Enable GitHub Copilot with `copilot-api provider enable github-copilot`, or enable another configured provider.",
    )
  }

  consola.info("No enabled providers found. Setting one up...")
  await runProviderSetup()

  if (state.githubToken && isGitHubCopilotEnabled()) {
    // The setup flow persisted the token with the credential store.
    await setupCopilotMode(state.githubToken, "file")
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
  const tlsModule = await import("./lib/http/tls")
  tlsModule.enableSystemCACompat()

  consola.options.throttle = 0

  const config = mergeConfigWithDefaults()

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
  await startModelsDevCache()

  const serverUrl = formatServerUrl(binding.clientHostname, options.port)

  const resolvedGitHubToken =
    isGitHubCopilotEnabled() ?
      await resolveGitHubToken(options.githubToken)
    : null
  if (resolvedGitHubToken && isGitHubCopilotEnabled()) {
    await setupCopilotMode(
      resolvedGitHubToken.token,
      resolvedGitHubToken.source,
    )
  } else {
    await setupProviderMode()
  }

  consola.box(
    `🌐 Dashboard Viewer: ${serverUrl}/usage-viewer?endpoint=${serverUrl}/usage`,
  )

  const { createServer } = await import("./server")
  const plugins = await loadGatewayPlugins(process.env.COPILOT_API_PLUGINS, {
    port: options.port,
    baseDir: PATHS.APP_DIR,
  })
  if (plugins) registerProcessCleanup(() => plugins.close())
  const server = createServer({
    networkExposed: binding.networkExposed,
    port: options.port,
    plugins,
  })

  const { initializeApiKeyQuotas } = await import(
    "./lib/auth/api-key-quota-runtime"
  )
  const { startTokenUsageRetention } = await import(
    "./lib/token-usage/retention"
  )
  const { startVideoUsageSettlement } = await import("./lib/video-settlement")
  const { settlePendingVideoUsage } = await import(
    "./services/xai/video-usage-settlement"
  )
  await startTokenUsageRetention()
  if (config.auth?.apiKeyConfigs?.some((key) => key.quota)) {
    try {
      await initializeApiKeyQuotas()
    } catch (error) {
      consola.warn("Failed to load API key quotas", error)
    }
  }
  startVideoUsageSettlement(settlePendingVideoUsage)

  const listener = serve({
    fetch: server.fetch as ServerHandler,
    hostname: binding.hostname,
    port: options.port,
    // The process cleanup runtime drains the listener before closing storage.
    gracefulShutdown: false,
    bun: {
      idleTimeout: 0,
    },
  })
  registerProcessShutdownDrain(async () => {
    const timeoutMs =
      (Number.parseInt(process.env.SERVER_SHUTDOWN_TIMEOUT ?? "", 10) || 5)
      * 1000
    const timer = new AbortController()
    try {
      const drained = await Promise.race([
        listener.close().then(() => true),
        delay(timeoutMs, false, { signal: timer.signal }),
      ])
      if (!drained) await listener.close(true)
    } finally {
      timer.abort()
    }
  })
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
      default: "4141",
      description: "Port to listen on (1-65535)",
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
  async run({ args }) {
    const port = parseServerPort(args.port)
    if (port === null) {
      return
    }

    return runServer({
      host: args.host,
      port,
      verbose: args.verbose,
      githubToken: args["github-token"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
    })
  },
})

export function parseServerPort(value: string): number | null {
  const trimmed = value.trim()
  if (!/^[0-9]+$/.test(trimmed)) {
    rejectServerPort(value)
    return null
  }

  const port = Number(trimmed)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    rejectServerPort(value)
    return null
  }

  return port
}

function rejectServerPort(value: string): void {
  process.stderr.write(
    `Invalid port ${JSON.stringify(value)}. Usage: copilot-api start --port <1-65535>\n`,
  )
  process.exitCode = 1
}
