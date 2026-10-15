# 命令行参考

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/cli.md)

<a id="command-structure"></a>

## 命令结构

Copilot API 现在使用子命令结构，主要命令包括：

- `start`：启动 AI gateway 服务。如果已有 GitHub token，则启用 Copilot 路径；如果没有 GitHub token，但存在至少一个启用中的 provider，则按 provider-only 模式启动；如果两者都没有，会引导你配置 provider。
- `auth`：仅执行 provider 登录或配置流程，不启动服务。可用于 GitHub Copilot 登录、Codex OAuth，或第三方 provider API key 配置。
- `debug`：显示诊断信息，包括版本、运行时详情、文件路径以及认证状态，便于排障与支持。

<a id="command-line-options"></a>

## 命令行选项

### 全局选项

以下选项可用于任意子命令。若在子命令之前传入，请使用 `--key=value` 形式：

| 选项 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| --api-home | API home 目录路径（设置 `COPILOT_API_HOME`） | 无 | 无 |
| --oauth-app | OAuth app 标识符（设置 `COPILOT_API_OAUTH_APP`） | 无 | 无 |
| --enterprise-url | GitHub Enterprise URL（设置 `COPILOT_API_ENTERPRISE_URL`） | 无 | 无 |

### Start 命令选项

以下是 `start` 命令可用的命令行选项：

| 选项 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| --host | 监听主机；非回环地址要求已配置网关 API Key | 127.0.0.1 | 无 |
| --port | 监听端口 | 4141 | -p |
| --verbose | 启用详细日志 | false | -v |
| --github-token | 直接提供 GitHub token（必须通过 `auth` 子命令生成）；建议使用 `COPILOT_API_GITHUB_TOKEN`，命令行参数会出现在进程列表中 | 无 | -g |
| --show-token | 在获取和刷新时显示 GitHub 与 Copilot token | false | 无 |
| --proxy-env | 从环境变量初始化代理 | false | 无 |

不建议把 GitHub token 放在命令行上：本机任意用户都能从进程列表里读到它，请优先使用 `COPILOT_API_GITHUB_TOKEN` 环境变量。token 的解析顺序为：`--github-token` → `COPILOT_API_GITHUB_TOKEN` → `auth login` 写入的 token 文件。

### Auth 命令选项

| 选项 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| --provider | 要登录或配置的 provider（`copilot`、`codex`、`opencode-go`、`kimi`、`deepseek`、`dashscope`、`openrouter` 或 `custom`） | 交互选择 | 无 |
| --alias | Codex 账号的可选别名，仅与 `--provider codex` 一起使用 | 无 | 无 |
| --verbose | 启用详细日志 | false | -v |
| --show-token | 认证时显示 GitHub token | false | 无 |

只有在需要启用 GitHub Copilot provider 时，才需要执行 `copilot-api auth login --provider copilot`。使用 `codex` 或第三方 provider-only 模式不要求配置 Copilot。

Codex provider 最多保存 3 个账号。使用 `copilot-api auth login --provider codex --alias work` 新增或更新账号，新登录账号会成为当前账号；使用 `copilot-api auth codex --list` 查看账号，使用 `copilot-api auth codex --use <alias-or-accountId>` 手动切换，使用 `copilot-api auth codex --remove <alias-or-accountId>` 移除未在使用的账号。别名不区分大小写，且不能与其他账号的别名或账号 ID 重复；正在使用的账号无法移除。切换或移除账号后需要重启正在运行的服务，使其停止使用旧账号；凭据刷新不会把已移除的账号写回。旧版单账号 `codex_credentials.json` 会自动兼容，并在下一次写入凭据时升级为多账号格式。

使用 `copilot-api auth login --provider deepseek`、`--provider dashscope`、`--provider openrouter`、`--provider opencode-go` 或 `--provider kimi` 可以通过 CLI 快速新增或更新这些常用第三方 provider。DeepSeek 会提示输入掩码显示的 `apiKey`、provider `type`（默认 `anthropic`），以及默认 `https://api.deepseek.com/anthropic` 的 `baseUrl`。DashScope 会提示输入掩码显示的 `apiKey`、provider `type`（默认 `openai-compatible`）和预填默认值的 `baseUrl`。OpenRouter 只提示输入掩码显示的 `apiKey` 和预填默认值的 `baseUrl`，并固定写入 `type: "anthropic"`。OpenCode Go 只提示输入掩码显示的 `apiKey` 和预填默认值的 `baseUrl`，并固定写入 `type: "openai-compatible"`（baseUrl `https://opencode.ai/zen/go`）。Kimi 会提示输入掩码显示的 `apiKey`、provider `type`（默认 `openai-compatible`）和默认值为 `https://api.kimi.com/coding` 的 `baseUrl`（同一个 base URL 同时支持 Anthropic 和 OpenAI-compatible 两种端点）。此外，OpenCode Go 先读取 models.dev 中模型级 `provider.npm`，缺失时再使用 provider 级 `npm`：`@ai-sdk/anthropic` 走 Anthropic Messages，`@ai-sdk/openai` 走 OpenAI Responses（模型设置 `shape: completions` 时走 OpenAI 兼容协议）；无法识别或缺失 `npm` 时默认走 OpenAI 兼容协议。配置并启用 provider 后，`copilot-api start` 可在没有 GitHub token 的情况下启动。

OpenCode Go 的模型列表（`/opencode-go/v1/models` 及 `/v1/models` 中的对应条目）来自 [models.dev/api.json](https://models.dev/api.json) 的 `opencode-go.models`。服务启动时先读取 `COPILOT_API_HOME`（或默认应用数据目录）下的 `models-dev-api.json`。有有效缓存时，服务立即开始监听并在后台刷新目录，此后每五分钟刷新一次；没有有效缓存时，启动会等待首次下载，获取目录失败则启动失败。刷新时有 `ETag` 或 `Last-Modified` 就使用条件请求，并将两个校验值连同 JSON 校验和保存到 `models-dev-api.meta.json`。收到 `304` 则保留现有缓存；后台刷新失败时继续使用上一份有效的磁盘或内存目录。`status: deprecated` 的模型不会出现在列表中。

使用 `copilot-api auth login --provider custom` 可以通过 CLI 新增或更新其他第三方 provider。先选择手动填写，或搜索现有的 models.dev 目录。目录仅列出具有 HTTP API URL、使用 Anthropic Messages、OpenAI 兼容 Chat Completions、OpenAI Responses 或 Google Gemini 协议的 provider；不包含 `openrouter`、`github-copilot` 和 `opencode-go`。选中后会将 provider ID、协议和 API URL 预填到可编辑字段中。若 `config.json` 没有为模型显式配置价格，则使用 models.dev 的模型价格以 USD 估算 token 费用。随后输入掩码显示的 `apiKey` 和 `authType`；`authType` 可保持 type 默认值，也可选择 `x-api-key` / `x-goog-api-key` / `authorization`。桌面端的自定义 provider 表单同样支持目录选择和手动填写。

网关 API Key 存放在 `config.json` 的 `auth.apiKeys` 中，可通过 `copilot-api auth keys` 管理（每次只执行一种操作）：`--add <key>` 添加、`--remove <key>` 删除、`--list` 列出全部、`--clear` 清空。客户端通过 `x-api-key` 或 `Authorization: Bearer` 使用任意已配置的 Key 认证。未配置任何 Key 时，回环监听会以“不校验认证”的方式启动并输出一条 info 级别提示；非回环监听则拒绝启动。

### Debug 命令选项

| 选项 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| --json | 以 JSON 输出调试信息 | false | 无 |

<a id="example-usage"></a>

## 使用示例

npm 包常用命令（推荐 Bun >= 1.4.0）：

```sh
# 基础启动
bunx --bun @jeffreycao/copilot-api start

# 自定义端口并开启详细日志
bunx --bun @jeffreycao/copilot-api start --port 8080 --verbose

# 执行认证流程
bunx --bun @jeffreycao/copilot-api auth login

# 配置第三方 provider，然后不依赖 GitHub Copilot 启动
bunx --bun @jeffreycao/copilot-api auth login --provider dashscope
bunx --bun @jeffreycao/copilot-api start

# 以 JSON 格式输出调试信息
bunx --bun @jeffreycao/copilot-api debug --json

# 也可以全局安装，再强制使用 Bun 运行已安装 CLI
bun add --global @jeffreycao/copilot-api
bun run --bun copilot-api start
```

配置 `dashscope` 后的 OpenAI 兼容 provider 调用示例：

```sh
curl http://localhost:4141/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"dashscope/qwen3.6-plus","messages":[{"role":"user","content":"hello"}]}'

curl http://localhost:4141/dashscope/v1/messages \
  -H "content-type: application/json" \
  -d '{"model":"qwen3.6-plus","max_tokens":1024,"messages":[{"role":"user","content":"hello"}]}'
```

缓存、升级及 Node.js 运行方式详见[安装与启动](getting-started.md#using-with-bun)。
