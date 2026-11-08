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

- `agent-inject` 保留现有子代理 marker 和可选的提示规则 hook。Claude Code 提供原生 session/agent 请求头时，该插件为可选安装。
- `tool-search` 会注册用于 GPT Responses deferred tool loading 的 `tool_search` MCP bridge。

- 本仓库中的 marketplace catalog：`.claude-plugin/marketplace.json`
- 本仓库中的插件源码：`plugin/claude/agent-inject`、`plugin/claude/tool-search`

远程添加 marketplace：

```sh
/plugin marketplace add https://github.com/caozhiyuan/copilot-api.git
```

从 marketplace 安装插件：

```sh
/plugin install tool-search@copilot-api-marketplace
# 可选：保留现有提示规则 hook
/plugin install agent-inject@copilot-api-marketplace
```

网关改用 Claude Code 原生的 `x-claude-code-session-id` 和 `x-claude-code-agent-id` 请求头识别子代理：session ID 用于主、子代理共享根会话，每个子代理的 session affinity 由 session ID 和 agent ID 组合得到。Claude、Codex、OpenCode 子代理的类型统一为 `subagent`。GitHub Copilot Messages proxy 模式也直接根据 Claude 原生 session 请求头选择，不再判断 metadata 格式。参见 [Claude Code 网关请求头文档](https://code.claude.com/docs/en/llm-gateway-protocol#request-headers)。

已有 `agent-inject` 无需更新。网关不再使用其旧 marker 判断归属，marker 仅作为普通提示词文本保留。插件仍保留返回 `{"continue": true}` 的 `UserPromptSubmit` hook，并支持以下可选的 `SessionStart` 提醒：

- `CLAUDE_PLUGIN_ENABLE_QUESTION_RULES=1` 启用使用 `AskUserQuestion` 的提醒。
- `CLAUDE_PLUGIN_ENABLE_NO_BACKGROUND_AGENTS_RULE=1` 启用避免使用 `run_in_background: true` 的提醒。

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
- v1 保留原有的子会话首条消息 marker 注入和根会话请求头。网关通过原生 `x-opencode-session-id` affinity 与根会话的差异识别子代理，忽略 marker 的归属信息
- v2 使用原生的 `x-parent-session-id`，插件只处理根会话 ID，保留原生的子会话和会话 affinity 请求头

v1 使用 `session.created`、`session.deleted`、`chat.message` 和 `chat.headers` 钩子；v2 使用 `session.hook("model.request", ...)` 修改请求头。原生的 `x-session-id` 保留为当前会话 ID。Messages 交互 ID、prompt cache key 和 OpenCode Go 缓存分组统一使用 trace 的根会话，缺失时回退到 session affinity。Usage 按当前 affinity 归属，缺失时使用根会话。`metadata.user_id` 仅作为请求数据透传，不再解析其中的会话信息，也不参与 Messages proxy 模式判断。遇到父会话缺失、查询失败或循环引用时，保留已有请求头。

已有 OpenCode 插件无需更新即可使用基于请求头的归属判断。v1 的 marker 仍作为普通提示词文本保留；v2 原本就使用请求头，不注入 marker。

Trace 的根会话依次读取 `x-claude-code-session-id`、`session-id`、`x-root-session-id`、`x-session-id`，跳过空白值。Claude Code 子代理的 affinity 组合原生 session ID 和 agent ID；OpenCode v1 保留 `x-opencode-session-id`，v2 保留原生 session affinity。Messages 和 Responses 路由统一使用 trace 中的子代理信息，不再解析消息正文中的旧 marker。`x-parent-session-id` 仅保留 OpenCode OAuth 所需的上游转发，不参与会话归属和 affinity 判断。
