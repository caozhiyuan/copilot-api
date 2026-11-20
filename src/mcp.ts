#!/usr/bin/env node

import { defineCommand } from "citty"

import { MCP_SUBCOMMAND } from "./lib/cli/fast-path"
import { runMcpServer } from "./lib/cli/mcp-server"

export const mcp = defineCommand({
  meta: {
    name: MCP_SUBCOMMAND,
    description: "Start the Copilot API MCP tool_search bridge over stdio",
  },
  run() {
    return runMcpServer()
  },
})
