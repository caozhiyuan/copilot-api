# Claude Code

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/claude-code.md)

<a id="using-with-claude-code"></a>

## 与 Claude Code 一起使用

这个 AI gateway 可以为 [Claude Code](https://docs.anthropic.com/en/claude-code) 提供后端能力。Claude Code 是 Anthropic 提供的实验性面向开发者的对话式 AI 助手。

启动网关，然后通过 `settings.json` 配置 Claude Code：

```sh
npx @jeffreycao/copilot-api@latest start
```

<a id="manual-configuration-with-settingsjson"></a>

### 通过 `settings.json` 手动配置

在项目根目录中创建 `.claude/settings.json` 文件，写入 Claude Code 使用网关所需的环境变量。

下面是一个 `.claude/settings.json` 示例：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "gpt-6.1-sol[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-6.1-sol[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-6.1-sol[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-6-luna[1m]",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "400000",
    "CLAUDE_CODE_AUTO_MODE_SERVER": "0",
    "CLAUDE_CODE_AUTO_MODE_MODEL": "codex-auto-review",
    "CLAUDE_CODE_USE_VERTEX": "0",
    "CLAUDE_CODE_USE_BEDROCK": "0",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "true",
    "CLAUDE_CODE_ENABLE_AWAY_SUMMARY": "0",
    "CLAUDE_CODE_TOTAL_TOKENS_REMINDER": "off",
    "CLAUDE_CODE_EFFORT_LEVEL": "max",
    "MCP_CONNECT_TIMEOUT_MS": "20000"
  },
  "alwaysThinkingEnabled": true,
  "showThinkingSummaries": true
}
```

- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"` 让 Claude Code 的 `/model` 菜单发现网关模型，参见[官方网关配置说明](https://code.claude.com/docs/en/llm-gateway-connect#add-gateway-models-to-the-model-picker)。当 User-Agent 包含 `claude`（不区分大小写）时，`/v1/models` 会给本身不含 `claude` 的模型名添加 `my-claude-`，保留 provider 前缀，并给所有模型 ID 追加 `[1m]`，不判断上下文大小。例如 `opencode-go/glm-5.3-flash` 返回为 `opencode-go/my-claude-glm-5.3-flash[1m]`，`claude-opus-4-8` 返回为 `claude-opus-4-8[1m]`。Messages 和 token 计数接口会在模型映射及 provider 路由前去掉这个兼容前缀和 `[1m]` 后缀；其他客户端的模型 ID 保持原有格式。
- 桌面端 **Coding Agent 展示模型** 通过 `agentsModels` 同时控制 Codex 和 Claude Code 的发现列表。填写上游原始模型 ID，不加 `my-claude-`、`[1m]` 或网关 provider 前缀。
- 模型显示名包含 provider，例如 `GLM-5.3-Flash (opencode-go)`。已有显示名会作为基础，已有相同 provider 前缀或后缀时不重复添加；Copilot 模型标记为 `github-copilot`。
- 请根据需要替换 `ANTHROPIC_DEFAULT_FABLE_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL` 和 `ANTHROPIC_DEFAULT_HAIKU_MODEL`。配置完成后，请安装 claude code 插件，见 [插件集成](integrations.md#plugin-integrations)。
- `CLAUDE_CODE_AUTO_MODE_MODEL`（Claude Code v2.1.302+）指定客户端 auto mode 分类器使用的模型，不影响服务端 auto mode 的模型。保持 `CLAUDE_CODE_AUTO_MODE_SERVER: "0"` 可使用客户端分类器。示例使用 `codex-auto-review`，需要启用 Codex provider，并通过网关默认模型映射路由；可按需替换为其他可用模型。网关的 `claudeAutoModel` 替换优先于请求中的模型：请在网关的 [config.json](configuration.md#configuration-configjson) 中显式设置 `"claudeAutoModel": ""` 来禁用该项替换，然后重启网关或通过桌面端应用修改；省略 `claudeAutoModel` 会恢复网关的动态默认替换。其他路由规则仍然生效，包括非 token 计费 Copilot 账号的 `smallModels.copilot` 预热模型替换。
- `CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off"` 用于关闭 Claude Code 的 total tokens 提醒功能。该功能开启时会在对话中注入 `<total_tokens>N tokens left</total_tokens>` 块，提示模型剩余的 token 预算；默认预算为 1500w（15,000,000）tokens，意义不大，因此这里配置为关闭。
- 将 `CLAUDE_CODE_ATTRIBUTION_HEADER` 设为 `0` 可以阻止 Claude Code 在 system prompt 中附加计费和版本信息，从而避免 prompt cache 失效。
- 关闭 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` 和 `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` 可以避免不必要地消耗额度。
- Claude Code WebSearch 已支持纯搜索请求。全新或未配置的安装中，全局 `messageApiWebSearchModel` 默认为 `parallel`，提供无需 key 的免费网页搜索和来源摘录。已有模型选择保持不变，仍可选择 Responses-capable GPT 模型或 `provider/model` 别名来使用原生搜索和生成答案；provider 路由请使用原生 Anthropic provider 或 `openai-responses` provider。只有在你明确想禁止这类流量时，才需要把 `WebSearch` 加到 `permissions.deny`。
- 如果使用的不是 Claude 模型，请不要启用 `ENABLE_TOOL_SEARCH`。如果使用的是 Claude 模型，则可以启用 `ENABLE_TOOL_SEARCH`。当前 Claude Code 使用的是客户端 tool search 模式，在该模式下每次加载 defer tools 都需要额外请求一次。
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW`：设置用于自动压缩计算的上下文容量（以 token 为单位）。默认使用模型自身的上下文窗口：标准模型为 200K，扩展上下文模型为 1M。使用 1M 上下文模型（如 `claude-opus-4-6[1m]`）时，可设置一个较低的值（如 `500000`）将窗口视为 500K 用于压缩计算。该值受限于模型的实际上下文窗口上限。`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 会基于此值的百分比生效。设置此变量可将压缩阈值与状态栏的 `used_percentage` 解耦（后者始终使用模型的完整上下文窗口）。

- `CLAUDE_CODE_PROMPT_CACHE_TTL`：Claude Code v2.1.242+ 可设为 `1h`，为 Claude 模型请求 1 小时 prompt cache；API key 场景默认使用 5 分钟缓存。网关会将客户端请求的 `extended-cache-ttl-2025-04-11` beta 和内容块上的 `cache_control.ttl` 透传到 Copilot Messages 上游，不会主动添加 1h 配置。GPT 模型不适用此设置。子代理等其他请求可单独设置 `subagentPromptCacheTtl` 或 `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`。完整优先级见 [Claude Code prompt caching 文档](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself)。
  - **风险提示：** [GitHub Copilot 官方价格文档](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)目前未单独列出 cache 1h 的价格。虽然 Copilot models 接口返回了 `cache_write_1h_price`，但该字段不等于官方已公开确认 1h 缓存的计费规则；使用有风险，请谨慎使用，并以上游实际支持情况和计费为准。

更多选项见：[Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

也可以参考 IDE 集成说明：[Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)
