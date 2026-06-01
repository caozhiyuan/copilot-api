#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import { mergeConfigWithDefaults } from "./lib/config"
import {
  writeEnvFile,
  sourceEnvFileInShellRc,
  buildClaudeEnvVars,
} from "./lib/env-file"
import { initOpencodeVersion } from "./lib/opencode"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { getConfiguredApiKeys } from "./lib/request-auth"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { logUser, setupCopilotToken, setupGitHubToken } from "./lib/token"
import {
  cacheMacMachineId,
  cacheModels,
  cacheVSCodeVersion,
  cacheVsCodeSessionId,
  cacheVsCodeDeviceId,
} from "./lib/utils"

interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  writeEnv: boolean
  sourceEnv: boolean
  model: string
  smallModel: string
}

export async function runServer(options: RunServerOptions): Promise<void> {
  // Work around unjs/consola#357 until a release includes PR #359.
  consola.options.throttle = 0

  // Ensure config is merged with defaults at startup
  mergeConfigWithDefaults()

  await initOpencodeVersion()

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

  if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
    await logUser()
  } else {
    await setupGitHubToken()
  }

  await setupCopilotToken()
  await cacheModels()

  consola.info(
    `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
  )

  const serverUrl = `http://localhost:${options.port}`

  if (options.sourceEnv && !options.writeEnv) {
    consola.warn(
      "--source-env has no effect without --write-env; skipping shell rc update.",
    )
  }

  if (options.writeEnv) {
    const authToken = getConfiguredApiKeys()[0] ?? "dummy"
    const written = await writeEnvFile({
      port: options.port,
      model: options.model,
      smallModel: options.smallModel,
      authToken,
    })
    consola.success(`Wrote env file to ${written}`)

    if (options.sourceEnv) {
      const { rcPath, added } = await sourceEnvFileInShellRc(written)
      if (added) {
        consola.success(
          `Added source block to ${rcPath}. Run \`source ${rcPath}\` or open a new shell to load it.`,
        )
      } else {
        consola.info(`Source block already present in ${rcPath}`)
      }
    }
  }

  if (options.claudeCode) {
    consola.log(
      "\n💡 Tip: The --claude-code flag simply generates a clipboard command for launching Claude Code. \n"
        + "All models remain fully accessible without this flag, just configure the model ID directly in your settings.json file.",
    )

    invariant(state.models, "Models should be loaded by now")

    const selectedModel = await consola.prompt(
      "Select a model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const selectedSmallModel = await consola.prompt(
      "Select a small model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const command = generateEnvScript(
      Object.fromEntries(
        buildClaudeEnvVars({
          port: options.port,
          model: selectedModel,
          smallModel: selectedSmallModel,
          authToken: "dummy",
        }),
      ),
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

  consola.box(
    `🌐 Usage Viewer: ${serverUrl}/usage-viewer?endpoint=${serverUrl}/usage`,
  )

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
    "write-env": {
      type: "boolean",
      default: false,
      description:
        "Write a copilot-api.env dotenv file (Claude + OpenAI compatible) to the app dir, then start the server",
    },
    "source-env": {
      type: "boolean",
      default: false,
      description:
        "Append a line to your shell rc (.zshrc/.bash_profile) that sources the generated env file. Requires --write-env",
    },
    model: {
      type: "string",
      default: "gpt-5.4",
      description: "Primary model ID for --write-env output",
    },
    "small-model": {
      type: "string",
      default: "gpt-5-mini",
      description: "Small/background model ID for --write-env output",
    },
  },
  run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)

    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      writeEnv: args["write-env"],
      sourceEnv: args["source-env"],
      model: args["model"],
      smallModel: args["small-model"],
    })
  },
})
