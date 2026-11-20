import { afterEach, describe, expect, mock, test } from "bun:test"

interface ToolResult {
  content: Array<{
    type: string
    text: string
  }>
}

interface RegisteredTool {
  name: string
  handler: (input: { names: string }) => ToolResult
}

let registeredTool: RegisteredTool | undefined
let connectedTransport: unknown
let serverInfo: { name: string; version: string } | undefined

class MockMcpServer {
  constructor(info: { name: string; version: string }) {
    serverInfo = info
  }

  registerTool(
    name: string,
    _config: unknown,
    handler: (input: { names: string }) => ToolResult,
  ): void {
    registeredTool = { name, handler }
  }

  connect(transport: unknown): void {
    connectedTransport = transport
  }
}

class MockStdioServerTransport {}

await mock.module("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: MockMcpServer,
}))
await mock.module("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: MockStdioServerTransport,
}))

const { runMcpServer } = await import("~/lib/cli/mcp-server")
const { mcp } = await import("~/mcp")

afterEach(() => {
  registeredTool = undefined
  connectedTransport = undefined
  serverInfo = undefined
})

describe("runMcpServer", () => {
  test("registers the bridge tool and connects stdio transport", async () => {
    await runMcpServer()

    expect(serverInfo).toEqual({ name: "tool_search", version: "1.0.0" })
    expect(registeredTool?.name).toBe("search")
    expect(connectedTransport).toBeInstanceOf(MockStdioServerTransport)

    const result = registeredTool?.handler({
      names: "TaskList, TaskGet, TaskList",
    })
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            type: "copilot_api_tool_search",
            names: ["TaskList", "TaskGet"],
          }),
        },
      ],
    })

    const command = mcp as unknown as {
      meta: { name: string }
      run: () => Promise<void>
    }
    expect(command.meta.name).toBe("mcp")
    await command.run()
  })
})
