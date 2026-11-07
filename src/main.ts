#!/usr/bin/env node

import { isMcpFastPath } from "./lib/fast-path"

// Fast path: `copilot-api mcp` starts the MCP bridge without loading citty
// or the gateway modules, keeping MCP client startup fast.
if (isMcpFastPath(process.argv)) {
  const { runMcpServer } = await import("./lib/mcp-server")
  await runMcpServer()
} else {
  const { defineCommand, runMain, parseArgs } = await import("citty")

  const cliArgs = {
    "api-home": {
      type: "string",
      description: "Path to the API home directory.",
    },
    "oauth-app": {
      type: "string",
      description: "OAuth app identifier.",
    },
    "enterprise-url": {
      type: "string",
      description: "Enterprise URL for GitHub.",
    },
  } as const

  const args = parseArgs(process.argv, cliArgs)

  // Set environment variables before loading other modules
  if (typeof args["api-home"] === "string") {
    process.env.COPILOT_API_HOME = args["api-home"]
  }
  if (typeof args["oauth-app"] === "string") {
    process.env.COPILOT_API_OAUTH_APP = args["oauth-app"]
  }
  if (typeof args["enterprise-url"] === "string") {
    process.env.COPILOT_API_ENTERPRISE_URL = args["enterprise-url"]
  }

  // Work around unjs/consola#392 until consola ships the upstream fix.
  if (
    process.platform === "win32"
    && process.stdout.isTTY
    && !process.env.WT_SESSION
  ) {
    process.env.WT_SESSION = "copilot-api"
  }

  const { bindElectronFetch } = await import("./lib/electron-fetch")
  bindElectronFetch()

  // Dynamically import other modules to ensure environment variables are set
  const { auth } = await import("./auth")
  const { debug } = await import("./debug")
  const { mcp } = await import("./mcp")
  const { start } = await import("./start")
  const { provider } = await import("./provider")

  const main = defineCommand({
    meta: {
      name: "copilot-api",
      description:
        "Local multi-provider AI gateway with OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages compatibility.",
    },
    subCommands: { auth, start, debug, mcp, provider },
    args: cliArgs,
  })

  await runMain(main)
}
