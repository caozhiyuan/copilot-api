# Codex

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/codex.md)

<a id="using-with-codex"></a>

## 与 Codex 一起使用

这个 AI gateway 也可以为 Codex 提供后端能力。

推荐使用 Codex `0.155.1` 版本。

### Codex `config.toml` 参考配置

在 `~/.codex/config.toml` 中加入：

```toml
model = "gpt-6.1-sol"
model_reasoning_effort = "max"
model_provider = "copilot_api"
model_reasoning_summary = "auto"
plan_mode_reasoning_effort = "max"
model_context_window = 272000
model_auto_compact_token_limit = 244800
# 沙箱策略。可改用 "workspace-write" 以启用限制。
sandbox_mode = "danger-full-access"
approvals_reviewer = "auto_review"
suppress_unstable_features_warning = true
web_search = "live"
service_tier = "default"
# Codex 0.156.0 及以上版本：先生成模型目录文件，再取消下一行的注释。
# model_catalog_json = "model_catalog.json"

[model_providers.copilot_api]
name = "OpenAI"
base_url = "http://localhost:4141"
model_catalog_url = "http://localhost:4141/models"
env_key = "GITHUB_COPILOT_API_KEY"
requires_openai_auth = true
supports_websockets = false
supports_standalone_web_search = true
wire_api = "responses"
request_max_retries = 3
stream_max_retries = 3
stream_idle_timeout_ms = 300000

[features]
remote_compaction_v2 = true
api_key_model_discovery = true
default_mode_request_user_input = true
standalone_web_search = true
daemon_auto_start = false
apps = false

[analytics]
enabled = false
```

> [!NOTE]
> `name` 一定要配置为 `"OpenAI"`。

### 自动审核模型映射

通过顶层 GitHub Copilot 路由使用 `approvals_reviewer = "auto_review"` 时，在网关 `config.json` 中加入以下映射：

```json
{
  "modelMappings": {
    "codex-auto-review": "gpt-5.6-luna"
  }
}
```

也可配置为 `"codex-auto-review": "codex/codex-auto-review"`，使用内置 `codex` provider。

### 一键生成 `model_catalog.json`

**Codex `0.156.0+`：** `api_key_model_discovery` 已成功加载模型列表，但 Codex 代码存在 bug，可通过本地模型目录临时规避。未登录 GPT 账号时也可使用本地目录；更早版本无需配置 `model_catalog_json`。

启动网关，安装 `curl` 及 Bun 或 Node.js，然后在仓库根目录运行[生成脚本](../../generate-model-catalog.sh)：

```sh
sh docs/generate-model-catalog.sh
```

默认连接 `http://localhost:4141`，输出至 `$HOME/.codex/model_catalog.json`；如需自定义，依次追加网关地址和输出路径参数。

- **鉴权：** 网关启用鉴权时，运行脚本前设置 `GITHUB_COPILOT_API_KEY`。
- **配置：** 生成后取消 `model_catalog_json` 的注释，并填入文件的绝对路径。
- **更新：** 网关模型或 provider 变化后，重新运行脚本并重启 Codex。

### Codex 模型目录与协议适配

Codex 模型选择界面会展示网关已配置 provider 提供的模型：

<img src="../../screenshots/codex-models.png" alt="Codex 模型选择界面展示网关提供的模型列表" width="900" />

> **模型切换：** 在 DeepSeek 与 Responses Lite 模型之间切换时，请新建 Codex 会话。

---
