# Plugins and Tool Search

For server-side request lifecycle and usage hooks, see [Gateway event plugins](gateway-plugins.md).

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/integrations.md)

## GPT Tool Search

Claude Code can use its native ToolSearch with `ENABLE_TOOL_SEARCH: "true"`. For GPT Responses requests whose resolved model is `gpt-5.4` or newer, the gateway translates client searches to Responses `tool_search`. The model and upstream service must support client mode, such as a compatible `gpt-6.1-sol` provider. Claude Code supplies the selected tool definitions on the follow-up request. Native search does not require the MCP bridge; see the [Claude Code configuration](claude-code.md#manual-configuration-with-settingsjson).

The existing MCP bridge remains available for Claude Code and opencode v1 when the client loads MCP servers and sends Anthropic Messages traffic through this gateway. To use the bridge with Claude Code, set `ENABLE_TOOL_SEARCH` to `false`; native ToolSearch takes priority when both are enabled.

If you install `tool-search@copilot-api-marketplace`, Claude Code receives this MCP bridge automatically and you can skip the manual Claude Code MCP setup below.

Add the tool search bridge to the MCP config used by Claude Code:

```json
{
  "mcpServers": {
    "tool_search": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@jeffreycao/copilot-api@latest", "mcp"]
    }
  }
}
```

opencode v2 does not need this bridge. It already defers MCP tools through Code Mode, where the model sees a single `execute` tool plus one namespace per deferred tool, so the Responses `tool_search` bridge has nothing left to do. Add the tool search bridge to the MCP config used by opencode v1 only:

```json
{
  "mcp": {
    "tool_search": {
      "type": "local",
      "command": ["npx", "-y", "@jeffreycao/copilot-api@latest", "mcp"]
    }
  }
}
```

For local development, use `bun` as the command and `["run", "./src/main.ts", "mcp"]` as the args.

Internally, the gateway configures OpenAI Responses `tool_search` in client-executed mode. Only eager tools and `tool_search` are sent in the top-level `tools` array; the selected deferred tool definitions are loaded as functions via `tool_search_output.tools`. The model is asked to return the exact deferred tool names it wants to load next.

The bridge uses direct tool selection, not query search. Its tool input is `names`, a comma-separated list of exact deferred tool names, for example `TaskList,TaskGet,mcp__fetch__fetch`.

## Plugin Integrations

Plugin integrations are available for Claude Code and opencode.

### Claude Code plugin integration (marketplace-based)

The Claude Code integration is packaged as two plugins:

- `agent-inject` injects `__SUBAGENT_MARKER__...` on `SubagentStart` and supports optional reminder hooks.
- `tool-search` registers the `tool_search` MCP bridge used for GPT Responses deferred tool loading.

- Marketplace catalog in this repository: `.claude-plugin/marketplace.json`
- Plugin sources in this repository: `plugin/claude/agent-inject`, `plugin/claude/tool-search`

Add the marketplace remotely:

```sh
/plugin marketplace add https://github.com/caozhiyuan/copilot-api.git
```

Install plugins from the marketplace as needed, for example:

```sh
/plugin install agent-inject@copilot-api-marketplace
```

To use the MCP bridge, also install `tool-search`. Native ToolSearch does not require this plugin:

```sh
/plugin install tool-search@copilot-api-marketplace
```

The gateway uses native `x-claude-code-session-id` and `x-claude-code-agent-id` headers for attribution: requests share a root session, with child affinity derived from the session and agent IDs. All children use the generic `subagent` type. The native Claude session header also selects Copilot Messages proxy mode. Existing plugins and reminder hooks remain compatible without an upgrade; legacy markers remain ordinary prompt text and no longer control attribution. `agent-inject` is optional for clients supplying native headers. See the [Claude Code gateway headers](https://code.claude.com/docs/en/llm-gateway-protocol#request-headers).

The `agent-inject` plugin also registers a `UserPromptSubmit` hook that returns `{"continue": true}`, and it can inject `SessionStart` reminder rules through environment variables:

- `CLAUDE_PLUGIN_ENABLE_QUESTION_RULES=1` enables the two reminders about using the `question` tool automatically for Claude Code.
- `CLAUDE_PLUGIN_ENABLE_NO_BACKGROUND_AGENTS_RULE=1` enables the `run_in_background: true` avoidance reminder for agent hooks.

The `tool-search` plugin bundles the same MCP bridge described in [GPT Tool Search](#gpt-tool-search), so Claude Code users do not need to add the `tool_search` server manually when they install that plugin.

The plugin also auto-approves bridge calls through a `PermissionRequest` hook scoped exactly to `mcp__plugin_tool-search_tool_search__search`. The hook does not approve other MCP tools and does not override explicit `ask` or `deny` permission rules.

### Opencode plugin

The Agent Context plugin is located at `plugin/opencode/agent-context.js` and registers as `copilot-api.agent-context`.

**Installation:**

Copy the plugin file to your opencode plugins directory:

```sh
# Clone or download this repository, then copy the plugin
cp plugin/opencode/agent-context.js ~/.config/opencode/plugins/
```

Or manually create the file at `~/.config/opencode/plugins/agent-context.js` with the plugin content. When upgrading, remove the old `subagent-marker.js` from the plugin directory to avoid loading it twice.

The same file supports the OpenCode v1 `server()` plugin entrypoint (checked against v1.17/v1.18) and the v2 `setup()` entrypoint (checked against v2.0.18). For earlier v1 versions that only accept function exports, remove the final `export default { ... }` block and keep the named `AgentContextPlugin` export.

**Features:**

- Follows every `parentID` to the root session and sets `x-root-session-id` to that root ID, including nested subagents and restored sessions
- On v1, prepends a marker system reminder (`__SUBAGENT_MARKER__...`) to the first child message while the gateway identifies children from the root and native current-session headers
- On v2, uses the native `x-parent-session-id`; the plugin only sets the root session ID and preserves native child-session and session affinity headers

v1 uses the `session.created`, `session.deleted`, `chat.message`, and `chat.headers` hooks. v2 updates headers through `session.hook("model.request", ...)`. The native `x-session-id` keeps the current session ID. Messages interaction IDs, prompt cache keys and OpenCode Go cache grouping use the trace root session, falling back to session affinity. Usage uses current affinity, falling back to the root session. `metadata.user_id` is no longer parsed for session identity or proxy selection. Missing parents, lookup failures, and cyclic ancestry leave existing headers intact.

Trace reads `x-claude-code-session-id`, `session-id`, `x-root-session-id`, then `x-session-id`, skipping blank values. OpenCode v1 retains `x-opencode-session-id` affinity; v2 retains native session affinity. Both Messages and Responses use trace subagent context: a request is a subagent only when the root and affinity are both present and differ, regardless of client or subagent hints. Subagent `session_id` uses the root and `agent_id` uses the affinity. Existing OpenCode plugins require no upgrade. `x-parent-session-id` is forwarded for OpenCode OAuth but does not determine identity or affinity.
