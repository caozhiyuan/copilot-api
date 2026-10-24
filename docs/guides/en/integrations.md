# Plugins and Tool Search

For server-side request lifecycle and usage hooks, see [Gateway event plugins](gateway-plugins.md).

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/integrations.md)

## GPT Tool Search

For GPT Responses models such as `gpt-5.4+`, this AI gateway can expose Responses `tool_search` through a small MCP bridge. The same bridge can be used by Claude Code and opencode v1, as long as the client loads MCP servers and sends Anthropic Messages traffic through this gateway.

Do not set Claude Code's native `ENABLE_TOOL_SEARCH` for GPT models. That flag enables Claude Code's own client-side tool search mode, and it may stop forwarding deferred tool definitions. This gateway needs the full tool definitions so it can keep the small always-loaded tool set eager and translate every other tool into Responses deferred namespaces.

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

Internally, the gateway now configures OpenAI Responses `tool_search` in client-executed mode. Deferred tools are still exposed as searchable namespaces, but the model is explicitly asked to return the exact deferred tool names it wants to load next.

The bridge uses direct tool selection, not query search. Its tool input is `names`, a comma-separated list of exact deferred tool names, for example `TaskList,TaskGet,mcp__fetch__fetch`.

## Plugin Integrations

Plugin integrations are available for Claude Code and opencode.

### Claude Code plugin integration (marketplace-based)

The Claude Code integration is packaged as two plugins:

- `agent-inject` injects `__SUBAGENT_MARKER__...` on `SubagentStart`, so the gateway can infer `x-initiator: agent`.
- `tool-search` registers the `tool_search` MCP bridge used for GPT Responses deferred tool loading.

- Marketplace catalog in this repository: `.claude-plugin/marketplace.json`
- Plugin sources in this repository: `plugin/claude/agent-inject`, `plugin/claude/tool-search`

Add the marketplace remotely:

```sh
/plugin marketplace add https://github.com/caozhiyuan/copilot-api.git
```

Install the plugins from the marketplace:

```sh
/plugin install agent-inject@copilot-api-marketplace
/plugin install tool-search@copilot-api-marketplace
```

After installation, `agent-inject` injects `__SUBAGENT_MARKER__...` on `SubagentStart`, and the gateway uses it to infer `x-initiator: agent`.

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
- On v1, prepends a marker system reminder (`__SUBAGENT_MARKER__...`) to the first child message so the gateway can identify subagent requests
- On v2, uses the native `x-parent-session-id`; the plugin only sets the root session ID and preserves native child-session and session affinity headers

v1 uses the `session.created`, `session.deleted`, `chat.message`, and `chat.headers` hooks. v2 updates headers through `session.hook("model.request", ...)`. The native `x-session-id` keeps the current session ID. The Messages API preserves the priority of `metadata.user_id`; without it, the API reads `x-root-session-id` before falling back to `x-session-id`. Prompt cache keys reverse that priority: `session-id`, then `x-root-session-id`, then `x-session-id`, then `metadata.user_id`, with session affinity as the last fallback, so sibling subagents share the root session's cache group. Missing parents, lookup failures, and cyclic ancestry leave existing headers intact.

The Responses API reads `session-id`, `x-root-session-id`, then `x-session-id`, skipping blank values.
