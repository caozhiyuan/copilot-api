import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

import { createMcpToolSearchSentinel } from "./tool-search"

const SERVER_NAME = "tool_search"
const SERVER_VERSION = "1.0.0"

export const runMcpServer = async (): Promise<void> => {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  })

  server.registerTool(
    "search",
    {
      title: "Tool Search Bridge",
      description:
        "Load deferred tools by exact name through the Copilot API tool_search bridge.",
      inputSchema: {
        names: z
          .string()
          .describe(
            'Comma-separated exact deferred tool names to load, for example "TaskList,TaskGet,mcp__fetch__fetch".',
          ),
      },
      _meta: {
        "anthropic/alwaysLoad": true,
      },
    },
    ({ names }) => ({
      content: [
        {
          type: "text",
          text: createMcpToolSearchSentinel(names),
        },
      ],
    }),
  )

  await server.connect(new StdioServerTransport())
}
