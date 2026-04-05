#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import { accountsManager } from "./lib/accounts-manager"
import { addAccountToRegistry, saveAccountToken } from "./lib/accounts-registry"
import {
  getModelRefreshIntervalMs,
  isAccountAffinityEnabled,
  mergeConfigWithDefaults,
} from "./lib/config"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { parseAccountType, type AccountType } from "./lib/types/account"
import {
  cacheMacMachineId,
  cacheVSCodeVersion,
  cacheVsCodeSessionId,
  cacheVsCodeDeviceId,
} from "./lib/utils"
import { getDeviceCode } from "./services/github/get-device-code"
import { getGitHubUser } from "./services/github/get-user"
import { pollAccessToken } from "./services/github/poll-access-token"

interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: AccountType
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
}

/**
 * Run the interactive authentication flow to add a new account.
 * Called automatically when no accounts are found.
 */
async function runAuthFlow(accountType: AccountType): Promise<void> {
  consola.warn("No accounts found. Starting authentication flow...")

  // Start device code flow
  const deviceResponse = await getDeviceCode()
  consola.info(
    `Please enter the code "${deviceResponse.user_code}" at ${deviceResponse.verification_uri}`,
  )

  // Poll for access token
  const token = await pollAccessToken(deviceResponse)

  if (state.showToken) {
    consola.info("GitHub token:", token)
  }

  // Get user info to determine account ID
  const user = await getGitHubUser({
    githubToken: token,
    accountType,
  })
  const accountId = user.login

  // Save token and add to registry
  await saveAccountToken(accountId, token)
  await addAccountToRegistry({
    id: accountId,
    accountType,
    addedAt: Date.now(),
  })

  consola.success(`Account "${accountId}" added successfully!`)
}

function logClaudeCodeTip(): void {
  consola.log(
    "\n💡 Tip: The --claude-code flag simply generates a clipboard command for launching Claude Code. \n"
      + "All models remain fully accessible without this flag, just configure the model ID directly in your settings.json file.",
  )
}

type AvailableModels = NonNullable<
  ReturnType<typeof accountsManager.getFirstAccountModels>
>

async function setupClaudeCode(
  models: AvailableModels,
  serverUrl: string,
): Promise<void> {
  const selectedModel = await consola.prompt(
    "Select a model to use with Claude Code",
    {
      type: "select",
      options: models.data.map((model) => model.id),
    },
  )

  const selectedSmallModel = await consola.prompt(
    "Select a small model to use with Claude Code",
    {
      type: "select",
      options: models.data.map((model) => model.id),
    },
  )

  const command = generateEnvScript(
    {
      ANTHROPIC_BASE_URL: serverUrl,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "true",
      CLAUDE_PLUGIN_ENABLE_QUESTION_RULES: "true",
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

export async function runServer(options: RunServerOptions): Promise<void> {
  // Ensure config is merged with defaults at startup
  mergeConfigWithDefaults()
  accountsManager.setAccountAffinityEnabled(isAccountAffinityEnabled())
  accountsManager.setModelsRefreshIntervalMs(getModelRefreshIntervalMs())

  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  state.verbose = options.verbose
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken

  await ensurePaths()
  await cacheVSCodeVersion()
  cacheMacMachineId()
  cacheVsCodeSessionId()
  await cacheVsCodeDeviceId()

  // Initialize accounts manager with VS Code version
  await accountsManager.initialize(state.vsCodeVersion)

  // If --github-token is provided, set it as a temporary (high priority) account
  if (options.githubToken) {
    await accountsManager.setTemporaryAccount(
      options.githubToken,
      options.accountType,
    )
    consola.info("Using provided GitHub token as temporary account")
  }

  // Check if we have any accounts, if not, start the auth flow
  if (!accountsManager.hasAccounts()) {
    try {
      await runAuthFlow(options.accountType)

      // Re-initialize accounts manager with the new account
      accountsManager.shutdown()
      await accountsManager.initialize(state.vsCodeVersion)
      accountsManager.setModelsRefreshIntervalMs(getModelRefreshIntervalMs())
    } catch (error) {
      consola.error("Failed to add account:", error)
      process.exit(1)
    }
  }

  // Get models from the first available account
  const models = accountsManager.getFirstAccountModels()

  consola.info(
    `Available models: \n${models?.data.map((model) => `- ${model.id}`).join("\n") ?? "(no models loaded)"}`,
  )

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    logClaudeCodeTip()
    invariant(models, "Models should be loaded by now")
    const availableModels = models
    await setupClaudeCode(availableModels, serverUrl)
  }

  consola.box(`🌐 Admin UI: ${serverUrl}/admin`)

  const { server } = await import("./server")

  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
    bun: {
      idleTimeout: 0,
    },
  })
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
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
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)

    let accountType: AccountType
    try {
      accountType = parseAccountType(args["account-type"])
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }

    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      accountType,
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
    })
  },
})
