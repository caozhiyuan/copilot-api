# Copilot API Proxy

[English](./README.md) | 简体中文

## 重要说明

> [!IMPORTANT]
> **使用前请先注意以下几点：**
>
> 1. **Claude Code 配置：** 与 Claude Code 搭配使用时，请将模型 ID 配置为 `claude-opus-4-6` 或 `claude-opus-4.6`。示例 claude `settings.json` 见 [通过 `settings.json` 手动配置](#manual-configuration-with-settingsjson)。
>
> 2. **推荐给 opencode 用户：** 对 opencode 而言，优先使用 opencode OAuth app。它与 opencode 内置的 GitHub Copilot provider 行为一致，且没有 Terms of Service 风险：
>    ```sh
>    npx @jeffreycao/copilot-api@latest --oauth-app=opencode start
>    ```
>
> 3. **内置 `codex` provider：** 执行一次 `npx @jeffreycao/copilot-api@latest auth login --provider codex` 后，AI gateway 会自动持久化并刷新 Codex OAuth 凭据。
>
> 4. **注意事项：** README 顶部移除的 GitHub Copilot warning 见 [GitHub Copilot 安全提示](./NOTICE.md#github-copilot-security-notice)。

---

## 项目概览

这个项目最初是一个通过逆向工程实现的 GitHub Copilot API 代理，但现在也可以看作一个小型 AI gateway。除了 Copilot，它还可以在同一个 OpenAI / Anthropic 兼容入口后面路由内置的 `codex` provider 和第三方 provider，例如 DashScope，让 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) 这类工具复用同一个本地端点。

在 GitHub Copilot 路径上，AI gateway 会在可用时优先使用 Copilot 原生的 Anthropic 风格 Messages API，在重工具调用场景下保留更原生的 Claude 行为。

## 功能特性

- **OpenAI 与 Anthropic 双兼容**：通过 `/v1/responses`、`/v1/chat/completions`、`/v1/models`、`/v1/embeddings` 和 `/v1/messages` 对外暴露同一个本地 AI gateway。
- **同一网关接入 Copilot、`codex` 与第三方 provider**：可统一路由 GitHub Copilot、内置 `codex` provider 和配置好的外部 provider。
- **面向 Claude 的更原生 Copilot 路由**：优先使用原生 `/v1/messages`，保留 Claude 风格工具流，支持 Anthropic beta 能力、通过 Responses-capable 模型支持 Claude WebSearch，并保留 subagent / session 标记。
- **Claude Code 与 OpenCode 集成**：兼容 Claude Code 与 OpenCode，也支持通过 `@ai-sdk/anthropic` 直接作为 Anthropic provider 使用。
- **灵活的认证与部署选项**：支持交互式登录、直接 token、个人 / Business / Enterprise、GitHub Enterprise、opencode OAuth 和自定义数据目录。
- **本地控制与可观测性**：提供使用量看板、速率限制、手动审批，以及调试时显示 token 的能力。
- **多 provider 路由**：可暴露 `/:provider/...` 路由，也可在顶层 API 上使用 `model: "provider/model"`。
- **更好的 token 与上下文管理**：支持精确 Claude token 计数，以及面向长对话的 GPT 上下文压缩。

## 前置要求

- Bun（>= 1.2.x）
- 如果要通过 `npx` 运行已发布 CLI，需要 Node.js
- 已订阅 Copilot 的 GitHub 账号（个人版、Business 或 Enterprise）

## 安装

安装依赖：

```sh
bun install
```

直接从源码启动服务：

```sh
bun run start start
```

## 通过 npx 使用

你可以直接用 npx 运行本项目：

> [!IMPORTANT]
> 通过 `npx` 运行时，token usage 存储会使用 Node 内置的 `node:sqlite` 模块。该能力会在 Node.js >= 22.13.0 时启用；Node.js < 22.13.0 时 CLI 仍可启动，但会禁用 token usage 存储。
>
> 如果不升级 Node.js 但仍需要 token usage 存储，可以改用 Bun 运行已发布 CLI：`bunx --bun @jeffreycao/copilot-api@latest start`。

```sh
npx @jeffreycao/copilot-api@latest start
```

带参数示例：

```sh
npx @jeffreycao/copilot-api@latest start --port 8080
```

如果只想做认证：

```sh
npx @jeffreycao/copilot-api@latest auth
```

## Electron 桌面应用

如果你更喜欢图形界面，仓库里还提供了位于 `desktop/` 的 Electron 桌面应用。它支持 GitHub Copilot 登录或手动填入 token，可以一键启动或停止本地代理，并在界面里直接查看本地端点、鉴权 Header、可用模型、额度和日志。

设置页还可以配置 `OAuth App`、`API Home`、`Enterprise URL`、详细日志以及最小化到托盘。桌面安装包发布在 GitHub Releases：

https://github.com/caozhiyuan/copilot-api/releases

下载对应平台的安装包后，在应用内登录、选择端口并启动服务，再把你的客户端指向应用里显示的本地端点即可。发布版桌面应用使用随包内置的 Electron 运行时，正常使用不需要额外安装 Node.js；token usage 历史记录会在该内置运行时支持 SQLite 时启用。

桌面应用里的高级配置页会通过 `GET/POST /admin/config/model-mappings` 读写这份共享的模型映射。同一份映射会统一作用于 `POST /v1/messages`、`POST /v1/messages/count_tokens`、`POST /v1/responses` 和 `POST /v1/chat/completions`，不再按接口区分。它使用的是 `auth.adminApiKey`，不是普通的 `auth.apiKeys`；应用会在服务启动并自动生成该 key 后，直接从 `config.json` 读取它来发起请求。

### 桌面应用截图

下面展示了桌面应用中的首页、Token 用量统计页面：

<p align="center">
  <img src="./docs/screenshots/desktop-dashboard.png" alt="Copilot API 桌面应用首页" width="49%" />
  <img src="./docs/screenshots/desktop-token-usage.png" alt="Copilot API 桌面应用 Token 用量页" width="49%" />
</p>

## 配合 Docker 使用

构建镜像：

```sh
docker build -t copilot-api .
```

通过 bind mount 运行容器，让认证数据在重启后保留：

```sh
mkdir -p ./copilot-data
docker run -p 4141:4141 -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api
```

这会把宿主机上的 `./copilot-data` 映射到容器内的 `/root/.local/share/copilot-api`，用于持久化 GitHub 认证数据。

也可以直接通过环境变量传入 GitHub token：

```sh
docker run -p 4141:4141 -e GH_TOKEN=your_github_token_here copilot-api
```

## 命令结构

Copilot API 现在使用子命令结构，主要命令包括：

- `start`：启动 Copilot API 服务。如有需要，也会自动处理认证。
- `auth`：仅执行 GitHub 认证流程，不启动服务。通常用于生成可与 `--github-token` 一起使用的 token，尤其适合非交互环境。
- `check-usage`：直接在终端中显示当前 GitHub Copilot 用量与额度信息（无需启动服务）。
- `debug`：显示诊断信息，包括版本、运行时详情、文件路径以及认证状态，便于排障与支持。

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
| --port | 监听端口 | 4141 | -p |
| --verbose | 启用详细日志 | false | -v |
| --account-type | 使用的账号类型（individual、business、enterprise） | individual | -a |
| --manual | 启用手动请求审批 | false | 无 |
| --rate-limit | 请求之间的速率限制秒数 | 无 | -r |
| --wait | 达到速率限制时等待，而不是直接报错 | false | -w |
| --github-token | 直接提供 GitHub token（必须通过 `auth` 子命令生成） | 无 | -g |
| --claude-code | 生成一个使用 Copilot API 配置启动 Claude Code 的命令 | false | -c |
| --show-token | 在获取和刷新时显示 GitHub 与 Copilot token | false | 无 |
| --proxy-env | 从环境变量初始化代理 | false | 无 |

### Auth 命令选项

| 选项 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| --verbose | 启用详细日志 | false | -v |
| --show-token | 认证时显示 GitHub token | false | 无 |

### Debug 命令选项

| 选项 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| --json | 以 JSON 输出调试信息 | false | 无 |

<a id="configuration-configjson"></a>

## 配置（config.json）

- **位置：** Linux/macOS 为 `~/.local/share/copilot-api/config.json`，Windows 为 `%USERPROFILE%\.local\share\copilot-api\config.json`。
- **默认结构：**
  ```json
  {
    "auth": {
      "apiKeys": [],
      "adminApiKey": "<startup 自动生成>"
    },
    "providers": {
      "custom": {
        "type": "anthropic",
        "enabled": true,
        "baseUrl": "your-base-url",
        "apiKey": "sk-your-provider-key",
        "authType": "x-api-key"
      },
      "dashscope": {
        "type": "openai-compatible",
        "enabled": true,
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode",
        "apiKey": "sk-your-dashscope-key",
        "models": {
          "qwen3.6-plus": {
            "temperature": 1,
            "topP": 0.95,
            "topK": 20,
            "extraBody": {
              "preserve_thinking": true
            }
          },
          "glm-5.1": {
            "temperature": 0.7,
            "topP": 0.95,
            "contextCache": true,
            "extraBody": {
              "preserve_thinking": true
            }
          }
        }
      }
    },
    "modelMappings": {},
    "extraPrompts": {
      "gpt-5-mini": "<built-in exploration prompt>",
      "gpt-5.3-codex": "<built-in commentary prompt>",
      "gpt-5.4-mini": "<built-in commentary prompt>",
      "gpt-5.4": "<built-in commentary prompt>",
      "gpt-5.5": "<built-in commentary prompt>"
    },
    "smallModel": "gpt-5-mini",
    "useResponsesApiContextManagement": true,
    "modelResponsesApiCompactThresholds": {
      "gpt-5.4": 217600,
      "gpt-5.5": 217600
    },
    "modelReasoningEfforts": {
      "gpt-5-mini": "low",
      "gpt-5.3-codex": "xhigh",
      "gpt-5.4-mini": "xhigh",
      "gpt-5.4": "xhigh",
      "gpt-5.5": "xhigh"
    },
    "useMessagesApi": true,
    "useResponsesApiWebSocket": true,
    "useResponsesApiWebSearch": true,
    "messageApiWebSearchModel": "gpt-5-mini"
  }
  ```
- **auth.apiKeys：** 用于普通非 admin 路由的 API key。支持多个 key 轮换使用。请求可通过 `x-api-key: <key>` 或 `Authorization: Bearer <key>` 进行认证。若为空或省略，则普通路由的认证会被禁用。
- **auth.adminApiKey：** 仅用于 `/admin/*` 路由的单个 admin key。若未配置，服务会在启动时自动生成一个随机 key，并回写到 `config.json`。它同样使用 `x-api-key` 或 `Authorization: Bearer` 这两种头，但普通 `auth.apiKeys` 不能访问 `/admin/*`。
- **modelMappings：** 用于顶层 `POST /v1/messages`、`POST /v1/messages/count_tokens`、`POST /v1/responses` 和 `POST /v1/chat/completions` 请求的精确 `sourceModel -> targetModel` 重写映射，这几类接口共用同一份规则。省略该字段或保留为 `{}` 时，不会做模型重写。`source` 和 `target` 都必须是非空字符串。`target` 可以是普通模型 ID，也可以是 `provider/model` 形式的别名，例如 `dashscope/qwen3.6-plus`；重写发生在 provider alias 解析之前。这些映射不再按接口区分。`GET/POST /admin/config/model-mappings` 管理接口读写的也只有这个字段。
- **extraPrompts：** `model -> prompt` 的映射。把 Anthropic 风格请求翻译给 Copilot 时，会将其附加到第一条 system prompt 后面。你可以借此为不同模型注入护栏或指引。缺失的默认项会自动补齐，但不会覆盖你自定义的 prompt。内置的 `gpt-5.3-codex` 和 `gpt-5.4` prompt 会启用带阶段感知的 commentary，让模型在工具调用或更深层推理前先发出简短的用户可见进度说明。
- **providers：** 全局上游 provider 映射。每个 provider key（例如 `dashscope`）都会变成一个路由前缀（`/dashscope/v1/messages`）。支持 `type: "anthropic"`、`type: "openai-compatible"` 和 `type: "openai-responses"`。顶层客户端也可以在 `/v1/messages`、`/v1/messages/count_tokens`、`/v1/responses` 和 `/v1/chat/completions` 中使用 `model: "dashscope/model-id"`；AI gateway 会在转发上游前移除 `dashscope/` 前缀。`GET /v1/models` 不聚合 provider 模型；provider 模型列表请使用 `GET /dashscope/v1/models`。
  - `enabled`：可选，若省略则默认为 `true`。
  - `baseUrl`：provider API 的基础 URL，不要带结尾的 endpoint。Anthropic provider 不要带 `/v1/messages`；OpenAI 兼容 provider 不要带 `/v1/chat/completions`；OpenAI Responses provider 不要带 `/v1/responses`。
  - `apiKey`：作为上游凭据值使用；普通 provider 必须配置。
  - `authType`：可选，控制 `apiKey` 如何发送到上游。普通 provider 支持 `x-api-key` 和 `authorization`。Anthropic provider 默认 `x-api-key`；OpenAI 兼容和 OpenAI Responses provider 默认 `authorization`。当设置为 `authorization` 时，代理会发送 `Authorization: Bearer <apiKey>`。`oauth2` 仅保留给内置 `codex` provider，并由 `auth login --provider codex` 自动写入。
  - `adjustInputTokens`：可选，当为 `true` 时，代理会在 usage 响应里用 `input_tokens` 减去 `cache_read_input_tokens`。
  - `models`：可选，按模型 ID 配置的映射。每个键为请求中的模型名，值支持：
    - `temperature`：可选，当请求未指定时使用的默认温度。
    - `topP`：可选，当请求未指定时使用的默认 `top_p`。
    - `topK`：可选，当请求未指定时使用的默认 `top_k`。
    - `extraBody`：可选，按模型合入上游请求体的动态字段；请求体显式同名字段优先。OpenAI 兼容 provider 可用它配置 `enable_thinking`、`preserve_thinking`、`reasoning_effort` 等字段。`thinking_budget` 是 OpenAI 兼容 provider 的特殊覆盖项：配置在 `extraBody` 后，会在 Anthropic `thinking.budget_tokens` 翻译之后强制写入，并覆盖请求派生出的预算值。
    - `contextCache`：可选，OpenAI 兼容 provider 默认 `true`，用于启用阿里云百炼/DashScope 的显式缓存（explicit context cache），会按其 Context Cache 格式在最多 4 个 content block 上注入 `cache_control: { "type": "ephemeral" }`。缓存断点策略与 opencode 主链路保持一致：前 2 条 system 消息 + 最后 2 条非 system 消息。标记字符串 content 时会把 `system` / `user` / `assistant` / `tool` 消息转换为 text content part 数组；已有数组 content 则标记最后一个 part。如果模型本身已经支持隐式缓存，或上游不支持该显式缓存扩展字段，可在模型配置中设为 `false`。
    - `supportPdf`：可选，控制该模型是否支持 PDF/document content。默认 `false`，不支持时会把 PDF 转成提示文本；设为 `true` 时会把 PDF/document 转成 OpenAI Chat Completions 的 file part。
    - `toolContentSupportType`：可选，配置该模型的 tool result content 支持能力，值为 `array`、`image`、`pdf` 的数组。provider 侧未配置时默认只发送 string tool content。若 `supportPdf` 为 `true` 但这里不包含 `pdf`，tool result 里的 file part 会被转成 user role 消息。Copilot 主链路不使用这个 provider 默认，仍按 array + image 且不支持 PDF 的能力处理。
- **smallModel：** 无工具预热消息的回退模型（例如 Claude Code 的探测请求）；默认是 `gpt-5-mini`。
- **useResponsesApiContextManagement：** 当为 `true` 时，代理会为 Responses API 附加 `context_management` 压缩指令。默认值为 `true`。如需全局关闭，可设为 `false`。启用后，请求体会带上 `context_management`，并在后续轮次中仅保留最新的压缩承载内容，因此特别适合长任务场景。
- **modelResponsesApiCompactThresholds：** 按模型覆盖 Responses API 的 `compact_threshold`，仅在代理自动附加 `context_management` 时使用。它的优先级高于 `resolveResponsesCompactThreshold` 基于 `max_prompt_tokens * ratio` 的兜底阈值。默认将 `gpt-5.4` 和 `gpt-5.5` 设为 `217600`（`272000 * 0.8`）。未列出的模型继续使用原有兜底逻辑。
- **modelReasoningEfforts：** 按模型配置发送到 Copilot Responses API 的 `reasoning.effort`。可选值包括 `none`、`minimal`、`low`、`medium`、`high` 和 `xhigh`。若某模型未配置，则默认使用 `high`。
- **useMessagesApi：** 当为 `true` 时，支持 Copilot 原生 `/v1/messages` 的 Claude 系模型会走 Messages API；否则回退到 `/chat/completions`。设为 `false` 可禁用 Messages API 路由，始终使用 `/chat/completions`。默认值为 `true`。
- **useResponsesApiWebSocket：** 当为 `true` 时，Responses API 请求会优先对声明了 `ws:/responses` 的模型使用 Copilot websocket transport；仅声明 `/responses` 的模型仍走 HTTP。设为 `false` 可禁用 websocket 路由，并在模型支持 `/responses` 时使用 HTTP `/responses`。默认值为 `true`。
- **useResponsesApiWebSearch：** 当为 `true` 时，服务端会保留 Responses API 中 `type: "web_search"` 的工具并透传到上游。设为 `false` 则会从 `/responses` payload 中移除这些工具。默认值为 `true`。
- **messageApiWebSearchModel：** 顶层 Copilot `/v1/messages` 请求只包含服务端 `web_search` 工具时使用的全局模型，默认值为 `gpt-5-mini`。如果该值是 `provider/model` 别名，请求会进入对应 provider 的 Messages API 路径，并在转发前移除 provider 前缀。对于 Copilot GPT 模型，web search 会通过 `/responses` 执行。混合 `web_search` 与自定义工具的场景暂不支持，服务端会移除 server-side `web_search`。
- **claudeTokenMultiplier：** 用于 Claude `/v1/messages/count_tokens` 请求在本地走 GPT tokenizer 估算时的乘数。默认值为 `1.15`。如果你的客户端仍然过晚触发上下文压缩，可以适当调大。这个配置只会在代理本地估算 Claude token 时生效；如果已经配置 `anthropicApiKey` 且 Anthropic token counting 调用成功，则会直接返回 Anthropic 的精确计数，不会使用这个乘数。
- **anthropicApiKey：** 用于把 Claude `/v1/messages/count_tokens` 请求转发到 Anthropic 真实 token counting 端点的 API key，这样会返回精确计数，而不是 GPT tokenizer 估算值。也可通过环境变量 `ANTHROPIC_API_KEY` 设置。若未配置，或上游调用失败，则回退到由 `claudeTokenMultiplier` 控制的本地 GPT tokenizer 估算。

编辑此文件后即可自定义 prompts，或替换为你自己的快速模型。修改完成后请重启服务（或重新执行命令），让缓存中的配置刷新生效。

## API 认证

- **受保护的普通路由：** 当配置了 `auth.apiKeys` 且非空时，除 `/`、`/usage-viewer` 和 `/usage-viewer/` 以外的普通路由都需要认证。
- **Admin 路由：** 所有 `/admin/*` 路由都要求 `auth.adminApiKey`。如果缺失，服务会在启动时自动生成并在开始提供服务前写回 `config.json`。
- **允许的认证头：**
  - `x-api-key: <your_key>`
  - `Authorization: Bearer <your_key>`
- **CORS 预检：** `OPTIONS` 请求始终允许。
- **未配置普通 key 时：** 普通路由仍可直接访问；但这条规则不适用于 `/admin/*`，后者只接受 `auth.adminApiKey`。

普通受保护路由的示例请求：

```sh
curl http://localhost:4141/v1/models \
  -H "x-api-key: your_api_key"
```

Admin 路由的示例请求：

```sh
curl http://localhost:4141/admin/config/model-mappings \
  -H "x-api-key: your_admin_api_key"
```

## API 端点

服务端提供多个端点来与 Copilot API 交互。它支持 OpenAI 兼容端点，也支持 Anthropic 兼容端点，因此可以更灵活地接入不同工具与服务。

### OpenAI 兼容端点

这些端点模拟 OpenAI API 结构。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `POST /v1/responses` | `POST` | OpenAI 中用于生成模型响应的高级接口。支持 `openai-responses` provider 的 `provider/model` 别名。 |
| `POST /v1/chat/completions` | `POST` | 为给定聊天对话创建模型响应。支持 `openai-compatible` provider 的 `provider/model` 别名。 |
| `GET /v1/models` | `GET` | 列出当前可用模型。 |
| `POST /v1/embeddings` | `POST` | 创建表示输入文本的向量嵌入。 |

### Anthropic 兼容端点

这些端点设计为兼容 Anthropic Messages API。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `POST /v1/messages` | `POST` | 为给定对话创建模型响应。支持已配置 provider 的 `provider/model` 别名。 |
| `POST /v1/messages/count_tokens` | `POST` | 计算一组消息的 token 数。支持已配置 provider 的 `provider/model` 别名。 |
| `POST /:provider/v1/messages` | `POST` | 将 Anthropic Messages 请求代理到已配置的 Anthropic、OpenAI 兼容或 OpenAI Responses provider。 |
| `GET /:provider/v1/models` | `GET` | 将模型列表请求代理到已配置的 provider。 |
| `POST /:provider/v1/messages/count_tokens` | `POST` | 为 provider 路由请求在本地计算 token 数。 |

### 使用量监控端点

用于监控 Copilot 用量与额度的新端点。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `GET /usage` | `GET` | 获取详细的 Copilot 使用统计与额度信息。 |
| `GET /token` | `GET` | 获取当前 API 正在使用的 Copilot token。 |

### Admin / 配置端点

这些端点用于本地管理操作，只接受 `auth.adminApiKey`。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `GET /admin/config/model-mappings` | `GET` | 返回当前 `config.json` 路径以及生效中的 `modelMappings` 映射。 |
| `POST /admin/config/model-mappings` | `POST` | 只更新 `config.json` 里的 `modelMappings` 字段，并回传更新后的结果。 |

## 使用示例

常用 `npx` 命令：

```sh
# 基础启动
npx @jeffreycao/copilot-api@latest start

# 自定义端口并开启详细日志
npx @jeffreycao/copilot-api@latest start --port 8080 --verbose

# 执行认证流程
npx @jeffreycao/copilot-api@latest auth login

# 在终端中查看 Copilot 用量与额度（无需启动服务）
npx @jeffreycao/copilot-api@latest check-usage

# 以 JSON 格式输出调试信息
npx @jeffreycao/copilot-api@latest debug --json

# 用 Bun 而不是 Node.js 运行已发布 CLI
bunx --bun @jeffreycao/copilot-api@latest start
```

## 与 Claude Code 一起使用

这个 AI gateway 可以为 [Claude Code](https://docs.anthropic.com/en/claude-code) 提供后端能力。Claude Code 是 Anthropic 提供的实验性面向开发者的对话式 AI 助手。

有两种方式可以把 Claude Code 配置为使用这个 AI gateway：

### 通过 `--claude-code` 标志进行交互式配置

执行带 `--claude-code` 的 `start` 命令开始：

```sh
npx @jeffreycao/copilot-api@latest start --claude-code
```

你会被提示选择一个主模型，以及一个用于后台任务的 “small, fast” 模型。选择完成后，会有一条命令被复制到剪贴板中。该命令会设置 Claude Code 使用这个 AI gateway 所需的环境变量。

在新的终端中粘贴并执行这条命令，即可启动 Claude Code。

<a id="manual-configuration-with-settingsjson"></a>

### 通过 `settings.json` 手动配置

另一种方式是在项目根目录中创建 `.claude/settings.json` 文件，并写入 Claude Code 所需的环境变量。这样你就不需要每次都运行交互式配置了。

下面是一个 `.claude/settings.json` 示例：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "gpt-5.4",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-5.4",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-5-mini",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "true",
    "CLAUDE_CODE_ENABLE_AWAY_SUMMARY": "0",
    "CLAUDE_PLUGIN_ENABLE_QUESTION_RULES": "true"
  },
  "permissions": {
    "deny": [
      "mcp__ide__executeCode"
    ]
  }
}
```

- 请根据需要替换 `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL` 和 `ANTHROPIC_DEFAULT_HAIKU_MODEL`。配置完成后，请安装 claude code 插件，见 [插件集成](#plugin-integrations)。
- 将 `CLAUDE_CODE_ATTRIBUTION_HEADER` 设为 `0` 可以阻止 Claude Code 在 system prompt 中附加计费和版本信息，从而避免 prompt cache 失效。
- 关闭 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` 和 `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` 可以避免不必要地消耗额度。
- Claude Code WebSearch 已支持纯搜索请求。Copilot 路径请保持全局 `messageApiWebSearchModel` 指向 Responses-capable GPT 模型或 `provider/model` 别名；provider 路由请使用原生 Anthropic provider 或 `openai-responses` provider。只有在你明确想禁止这类流量时，才需要把 `WebSearch` 加到 `permissions.deny`。
- 如果使用的不是 Claude 模型，请不要启用 `ENABLE_TOOL_SEARCH`。如果使用的是 Claude 模型，则可以启用 `ENABLE_TOOL_SEARCH`。当前 Claude Code 使用的是客户端 tool search 模式，在该模式下每次加载 defer tools 都需要额外请求一次。
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW`：设置用于自动压缩计算的上下文容量（以 token 为单位）。默认使用模型自身的上下文窗口：标准模型为 200K，扩展上下文模型为 1M。使用 1M 上下文模型（如 `claude-opus-4-6[1m]`）时，可设置一个较低的值（如 `500000`）将窗口视为 500K 用于压缩计算。该值受限于模型的实际上下文窗口上限。`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 会基于此值的百分比生效。设置此变量可将压缩阈值与状态栏的 `used_percentage` 解耦（后者始终使用模型的完整上下文窗口）。

更多选项见：[Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

也可以参考 IDE 集成说明：[Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

## GPT Tool Search

对于 `gpt-5.4+` 这类 GPT Responses 模型，这个 AI gateway 可以通过一个很小的 MCP bridge 暴露 Responses `tool_search`。Claude Code 和 opencode 都可以使用同一个 bridge，前提是客户端会加载 MCP server，并且 Anthropic Messages 流量会经过这个 AI gateway。

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

请把 tool search bridge 加到 opencode 使用的 MCP 配置中：

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

## 与 OpenCode 一起使用

OpenCode 已经有直接的 GitHub Copilot provider。本节适用于你希望让 OpenCode 通过 `@ai-sdk/anthropic` 指向这个 AI gateway，并复用本 README 前面提到的 agent 行为时。

### 最小配置

使用 OpenCode OAuth app 启动 AI gateway：

```sh
npx @jeffreycao/copilot-api@latest --oauth-app=opencode start
```

然后让 OpenCode 通过 `@ai-sdk/anthropic` 指向这个 AI gateway。

示例 `~/.config/opencode/opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "local/gpt-5.4",
  "small_model": "local/gpt-5-mini",
  "agent": {
    "build": {
      "model": "local/gpt-5.4"
    },
    "plan": {
      "model": "local/gpt-5.4"
    },
    "explore": {
      "model": "local/gpt-5-mini"
    }
  },
  "provider": {
    "local": {
      "npm": "@ai-sdk/anthropic",
      "name": "Copilot API Proxy",
      "options": {
        "baseURL": "http://localhost:4141/v1",
        "apiKey": "dummy"
      },
      "models": {
        "gpt-5.4": {
          "name": "gpt-5.4",
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": {
            "context": 300000,
            "output": 128000
          }
        },
        "gpt-5-mini": {
          "name": "gpt-5-mini",
          "limit": {
            "context": 200000,
            "output": 64000
          }
        },
        "claude-sonnet-4.6": {
          "id": "claude-sonnet-4.6",
          "name": "claude-sonnet-4.6",
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": {
            "context": 200000,
            "output": 32000
          },
          "options": {
            "thinking": {
              "type": "enabled",
              "budgetTokens": 31999
            }
          }
        }
      }
    }
  }
}
```

这些字段的重要性：

- `npm: "@ai-sdk/anthropic"` 是关键。OpenCode 会以 Anthropic Messages 语义与这个 AI gateway 通信，而不是把一切扁平化为 OpenAI Chat Completions。
- `options.baseURL` 应设为 `http://localhost:4141/v1`；Anthropic SDK 会自动补上 `/messages`、`/models` 和 `/messages/count_tokens`。
- `model`、`small_model` 与 `agent.*.model` 让你可以把 `gpt-5.4` 用于 build/plan，同时把探索和后台工作路由到 `gpt-5-mini`。
- 如果你在此代理中启用了 `auth.apiKeys`，请把 `dummy` 替换为真实 key；否则任意占位值都可以。

## 与 Codex 一起使用

这个 AI gateway 也可以为 Codex 提供后端能力。

### Codex `config.toml` 参考配置

把以下 `[model_providers.copilot_api]` 段加入你的 Codex `~/.codex/config.toml`：

```toml
model_provider = "copilot_api"
model_reasoning_summary = "auto"
model_verbosity = "medium"
model_context_window = 272000
model_auto_compact_token_limit = 244800

[model_providers.copilot_api]
name = "OpenAI"
base_url = "http://localhost:4141"
env_key = "GITHUB_COPILOT_API_KEY"
requires_openai_auth = true
supports_websockets = false
wire_api = "responses"
request_max_retries = 3
stream_max_retries = 1
stream_idle_timeout_ms = 300000

[features]
remote_compaction_v2 = true

[analytics]
enabled = false
```

> [!NOTE]
> 此配置仅限于 Codex 与 GitHub Copilot provider。`name` 一定要配置为 `"OpenAI"`。它可以缓解 Codex local compact 不命中缓存的问题。如果你已开启 `useResponsesApiContextManagement`（Responses API context management 压缩），通常不会走到 `remote_compaction_v2` 或者 local compact，但如果工具返回 tokens 过大，仍有可能触发。

<a id="plugin-integrations"></a>

## 插件集成

本项目为 Claude Code 和 opencode 提供了插件集成。

#### Claude Code 插件集成（基于 marketplace）

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

- `CLAUDE_PLUGIN_ENABLE_QUESTION_RULES=1` 会自动为 Claude Code 启用两条关于使用 `question` 工具的提醒。你也可以把同样的提醒手动写进 `CLAUDE.md`；见 [CLAUDE.md 或 AGENTS.md 推荐内容](#claudemd-or-agentsmd-recommended-content)。
- `CLAUDE_PLUGIN_ENABLE_NO_BACKGROUND_AGENTS_RULE=1` 会启用关于避免在 agent hooks 中使用 `run_in_background: true` 的提醒。

`tool-search` 插件内置了 [GPT Tool Search](#gpt-tool-search) 一节描述的同一个 MCP bridge，因此安装该插件后，Claude Code 用户无需再手动配置 `tool_search` server。

#### Opencode 插件

subagent 标记生成器被打包为一个 opencode 插件，位于 `plugin/opencode/subagent-marker.js`。

**安装方式：**

将插件文件复制到你的 opencode 插件目录：

```sh
# 克隆或下载本仓库后复制该插件
cp plugin/opencode/subagent-marker.js ~/.config/opencode/plugins/
```

或者手动在 `~/.config/opencode/plugins/subagent-marker.js` 创建该文件，并填入插件内容。

**功能：**

- 跟踪 subagent 创建的子会话
- 自动在 subagent 聊天消息前添加 marker system reminder（`__SUBAGENT_MARKER__...`）
- 设置 `x-session-id` 请求头以跟踪会话
- 让这个 AI gateway 能够把来自 subagent 的请求识别为 `x-initiator: agent`

该插件会挂接到 `session.created`、`session.deleted`、`chat.message` 和 `chat.headers` 事件上，以无缝提供 subagent marker 能力。

## 使用量查看器

服务启动后，控制台会输出一个 Copilot 使用量看板 URL。这个看板是一个用于监控 API 用量的 Web 界面。

1. 启动服务。例如使用 npx：
   ```sh
   npx @jeffreycao/copilot-api@latest start
   ```
2. 服务会输出一个 usage viewer 的 URL。将它复制到浏览器中打开，形式大致如下：
   `http://localhost:4141/usage-viewer?endpoint=http://localhost:4141/usage`
   - 如果你在 Windows 上使用 `start.bat` 脚本，这个页面会自动打开。

看板提供了更易读的 Copilot 用量视图：

> token usage 历史记录需要 Bun 或 Node.js >= 22.13.0。Node.js < 22.13.0 时服务会正常运行，但 token usage 存储会被禁用。

- **API Endpoint URL**：看板会通过 URL 查询参数，默认从本地服务端点拉取数据。你也可以把这个 URL 改成任意其他兼容 API 端点。
- **Fetch Data**：点击 “Fetch” 按钮即可加载或刷新使用数据。页面首次加载时也会自动拉取。
- **Usage Quotas**：使用进度条汇总展示 Chat、Completions 等不同服务的额度使用情况。
- **Detailed Information**：可查看 API 返回的完整 JSON，以便深入分析所有可用统计信息。
- **URL-based Configuration**：你也可以直接通过 URL 查询参数指定 API 端点，便于收藏或分享。例如：
  `http://localhost:4141/usage-viewer?endpoint=http://your-api-server/usage`

### Usage Viewer 截图

<p align="center">
  <img src="./docs/screenshots/usage-viewer.png" alt="Copilot API Usage Viewer 页面" width="900" />
</p>

## 从源码运行

本项目可以通过多种方式从源码运行：

### 开发模式

```sh
bun run dev start
```

### 生产模式

```sh
bun run start start
```

## 使用建议

- 为避免触发 GitHub Copilot 速率限制，可以使用以下参数：
  - `--manual`：为每个请求启用手动审批，让你完全控制何时发送请求。
  - `--rate-limit <seconds>`：强制请求之间至少保持一定秒数的间隔。例如 `copilot-api start --rate-limit 30` 会确保两次请求之间至少间隔 30 秒。
  - `--wait`：与 `--rate-limit` 配合使用。在命中速率限制时，服务会等待冷却结束，而不是直接返回错误。对于不会自动重试的客户端，这会很有帮助。
- 如果你使用的是 GitHub Business 或 Enterprise 版 Copilot 账号，请使用 `--account-type` 参数（例如 `--account-type business`）。详见 [官方文档](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization)。

<a id="claudemd-or-agentsmd-recommended-content"></a>

### CLAUDE.md 或 AGENTS.md 推荐内容

如果你想手动加入这些提醒，请在 Claude Code 的 `CLAUDE.md`，或 opencode/codex 的 `AGENTS.md` 中加入以下内容：

```
- Prohibited from directly asking questions to users, MUST use question tool.
- Once you can confirm that the task is complete, MUST use question tool to make user confirm. The user may respond with feedback if they are not satisfied with the result, which you can use to make improvements and try again, after try again, MUST use question tool to make user confirm again.
```
