# 插件与工具搜索

服务端请求生命周期和用量事件扩展见[网关事件插件](gateway-plugins.md)。

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/integrations.md)

<a id="gpt-tool-search"></a>

## GPT Tool Search

对于 `gpt-5.4+` 这类 GPT Responses 模型，这个 AI gateway 可以通过一个很小的 MCP bridge 暴露 Responses `tool_search`。Claude Code 和 opencode v1 都可以使用同一个 bridge，前提是客户端会加载 MCP server，并且 Anthropic Messages 流量会经过这个 AI gateway。

GPT 模型不要设置 Claude Code 原生的 `ENABLE_TOOL_SEARCH`。这个开关启用的是 Claude Code 自己的客户端 tool search 模式，可能导致 deferred 工具定义不再转发给 AI gateway。这个 AI gateway 需要完整的工具定义，这样才能只保留那一小组常驻加载工具，其余工具统一转换为 Responses deferred namespace。

如果你安装了 `tool-search@copilot-api-marketplace`，Claude Code 会自动带上这个 MCP bridge，可以跳过下面这段 Claude Code MCP 手动配置。

请把 tool search bridge 加到 Claude Code 使用的 MCP 配置中：

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

opencode v2 不需要这个 bridge。v2 已经通过 Code Mode 延迟加载 MCP 工具，模型只会看到一个 `execute` 工具和每个 deferred 工具对应的 namespace，Responses `tool_search` bridge 没有用武之地。请只把 tool search bridge 加到 opencode v1 使用的 MCP 配置中：

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

本地开发时可以将命令换成 `bun`，参数换成 `["run", "./src/main.ts", "mcp"]`。

AI gateway 内部现在会把 OpenAI Responses `tool_search` 配置成 client-executed 模式。deferred tools 仍然会作为可搜索 namespace 暴露给模型，但会明确要求模型直接返回下一步要加载的精确工具名列表。

该 bridge 使用直接工具选择，不做 query 搜索。工具入参是 `names`，值为逗号分隔的精确 deferred 工具名，例如 `TaskList,TaskGet,mcp__fetch__fetch`。

<a id="plugin-integrations"></a>

## 插件集成

本项目为 Claude Code 和 opencode 提供了插件集成。

### Claude Code 插件集成（基于 marketplace）

Claude Code 集成现在拆分为两个插件：

- `agent-inject` 会在 `SubagentStart` 时注入 `__SUBAGENT_MARKER__...`，以便 AI gateway 推导 `x-initiator: agent`。
- `tool-search` 会注册用于 GPT Responses deferred tool loading 的 `tool_search` MCP bridge。

- 本仓库中的 marketplace catalog：`.claude-plugin/marketplace.json`
- 本仓库中的插件源码：`plugin/claude/agent-inject`、`plugin/claude/tool-search`

远程添加 marketplace：

```sh
/plugin marketplace add https://github.com/caozhiyuan/copilot-api.git
```

从 marketplace 安装插件：

```sh
/plugin install agent-inject@copilot-api-marketplace
/plugin install tool-search@copilot-api-marketplace
```

安装后，`agent-inject` 会在 `SubagentStart` 时注入 `__SUBAGENT_MARKER__...`，AI gateway 会利用它推导 `x-initiator: agent`。

`agent-inject` 还会注册一个 `UserPromptSubmit` hook，并返回 `{"continue": true}`；同时它也可以通过环境变量注入 `SessionStart` reminder 规则：

- `CLAUDE_PLUGIN_ENABLE_QUESTION_RULES=1` 会自动为 Claude Code 启用两条关于使用 `question` 工具的提醒。
- `CLAUDE_PLUGIN_ENABLE_NO_BACKGROUND_AGENTS_RULE=1` 会启用关于避免在 agent hooks 中使用 `run_in_background: true` 的提醒。

`tool-search` 插件内置了 [GPT Tool Search](#gpt-tool-search) 一节描述的同一个 MCP bridge，因此安装该插件后，Claude Code 用户无需再手动配置 `tool_search` server。

该插件还通过精确匹配 `mcp__plugin_tool-search_tool_search__search` 的 `PermissionRequest` hook 自动批准 bridge 调用。这个 hook 不会批准其他 MCP 工具，并且不会覆盖显式的 `ask` 或 `deny` 权限规则。

### Opencode 插件

Agent Context 插件位于 `plugin/opencode/agent-context.js`，注册 ID 为 `copilot-api.agent-context`。

**安装方式：**

将插件文件复制到你的 opencode 插件目录：

```sh
# 克隆或下载本仓库后复制该插件
cp plugin/opencode/agent-context.js ~/.config/opencode/plugins/
```

或者手动在 `~/.config/opencode/plugins/agent-context.js` 创建该文件，并填入插件内容。升级时请移走插件目录中的旧 `subagent-marker.js`，避免重复加载。

同一个文件支持 OpenCode v1 的 `server()` 插件入口（已核对 v1.17/v1.18）和 v2 的 `setup()` 入口（已核对 v2.0.18）。仅支持函数导出的更早 v1 版本，需要删除文件末尾的 `export default { ... }`，保留 `AgentContextPlugin` 命名导出。

**功能：**

- 沿 `parentID` 逐层查到根会话，将 `x-root-session-id` 设置为根会话 ID，支持多层 subagent 和恢复的会话
- v1 在子会话首条聊天消息前添加 marker system reminder（`__SUBAGENT_MARKER__...`），让这个 AI gateway 识别 subagent 请求
- v2 使用原生的 `x-parent-session-id`，插件只处理根会话 ID，保留原生的子会话和会话 affinity 请求头

v1 使用 `session.created`、`session.deleted`、`chat.message` 和 `chat.headers` 钩子；v2 使用 `session.hook("model.request", ...)` 修改请求头。原生的 `x-session-id` 保留为当前会话 ID。Messages API 保留 `metadata.user_id` 的解析优先级；没有该值时，先读取 `x-root-session-id`，再回退到 `x-session-id`。prompt cache key 的优先级相反：`session-id`、`x-root-session-id`、`x-session-id` 优先于 `metadata.user_id`，最后回退到会话 affinity，让同一根会话下的子代理共享缓存分组。遇到父会话缺失、查询失败或循环引用时，保留已有请求头。

Responses API 按 `session-id`、`x-root-session-id`、`x-session-id` 的顺序读取会话 ID，跳过空白值。
