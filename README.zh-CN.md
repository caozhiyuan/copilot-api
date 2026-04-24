# Copilot API Proxy

[English](./README.md) | 简体中文

> [!WARNING]
> 这是一个通过逆向工程实现的 GitHub Copilot API 代理。它不受 GitHub 官方支持，并且可能随时异常失效。请自行承担使用风险。当前版本中，如果不使用 opencode OAuth，设备 ID 和机器 ID 会被发送给 GitHub Copilot。不建议在单台设备上使用大量账号；如确有需要，建议放在 Docker 容器中运行。

> [!WARNING]
> **GitHub 安全提示：**  
> 过度自动化或脚本化地使用 Copilot（包括高频或批量请求，例如通过自动化工具发起）可能触发 GitHub 的滥用检测系统。  
> 你可能会收到 GitHub Security 的警告，进一步的异常活动还可能导致 Copilot 访问权限被暂时停用。
>
> GitHub 禁止使用其服务器进行过度批量自动化活动，或任何对其基础设施造成不当负载的行为。
>
> 请阅读：
>
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
>
> 请负责任地使用本代理，避免账号受到限制。

---

> [!NOTE]
> [opencode](https://github.com/sst/opencode) 已经内置 GitHub Copilot provider，因此在基础使用场景下你未必需要本项目。如果你希望 OpenCode 通过 `@ai-sdk/anthropic` 接入 Copilot、保留 Anthropic Messages 的工具调用语义、对 Claude 系模型优先走原生 Messages API 而不是 Chat Completions API、使用带阶段提示的 gpt commentary，或者优化 premium request 的消耗，这个代理仍然很有价值。

---

## 重要说明

> [!IMPORTANT]
> **使用前请先注意以下几点：**
>
> 1. **Claude Code 配置：** 与 Claude Code 搭配使用时，请将模型 ID 配置为 `claude-opus-4-6` 或 `claude-opus-4.6`（不要带 `[1m]` 后缀，超出 GitHub Copilot 上下文窗口限制太多可能导致账号被封）。示例 claude `settings.json` 见 [通过 `settings.json` 手动配置](#manual-configuration-with-settingsjson)。
>
> 2. **推荐给 opencode 用户：** 与 opencode 搭配时，推荐优先使用 opencode OAuth app 启动。该方式与 opencode 内置的 GitHub Copilot provider 行为一致，且不存在 Terms of Service 风险：
>    ```sh
>    npx @jeffreycao/copilot-api@latest --oauth-app=opencode start
>    ```
>
> 3. **通过 codex 使用时请关闭 multi agent：** 如果你是通过 GitHub Copilot 使用 codex，建议关闭 multi agent 功能。目前 GitHub Copilot 在 codex 场景下会按最后一条消息是否为 user role 计费，而这部分计费逻辑尚未调整。

---

## 项目概览

这是一个通过逆向工程实现的 GitHub Copilot API 代理，它将 Copilot 暴露为同时兼容 OpenAI 和 Anthropic 的服务。这样你就可以在任何支持 OpenAI Chat Completions / Responses API 或 Anthropic Messages API 的工具中使用 GitHub Copilot，包括把它作为 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) 的后端。

相比单纯把所有请求都转成 Chat Completions 兼容模式，这个代理可以对 Claude 系模型优先使用 Copilot 原生的 Anthropic 风格 Messages API，保留更多原生思考与工具调用语义，减少预热或恢复工具轮次时不必要的 Premium 请求消耗，并暴露带阶段感知的 `gpt-5.4` / `gpt-5.3-codex` 响应，让用户更容易跟踪模型正在做什么。

## 功能特性

- **OpenAI 与 Anthropic 双兼容**：以 OpenAI 兼容接口（`/v1/responses`、`/v1/chat/completions`、`/v1/models`、`/v1/embeddings`）和 Anthropic 兼容接口（`/v1/messages`）对外暴露 GitHub Copilot。
- **Claude 模型优先走 Anthropic 原生路由**：当模型支持 Copilot 原生 `/v1/messages` 端点时，代理会优先使用它，而不是 `/responses` 或 `/chat/completions`，从而保留 Anthropic 风格的 `tool_use` / `tool_result` 流程以及更原生的 Claude 行为。
- **减少不必要的 Premium 请求**：通过把预热请求路由到 `smallModel`、将 `tool_result` 的后续消息重新并入工具流，以及把恢复的工具轮次视为延续流量而非全新高级交互，减少浪费的 premium 使用量。
- **分阶段的 `gpt-5.4` 与 `gpt-5.3-codex`**：这些模型可以在更深入推理或调用工具前先发出面向用户的 commentary，让长时间运行的编码操作更容易理解，而不是突然开始一串工具调用。
- **支持 Claude 原生 Beta 能力**：在 Messages API 路径上支持 Anthropic 原生能力，例如 `interleaved-thinking`、`advanced-tool-use` 和 `context-management`；这些能力在普通 Chat Completions 兼容模式下通常很难支持，或根本不可用。
- **Subagent 标记集成**：Claude Code 与 opencode 插件可以注入 `__SUBAGENT_MARKER__...`，并传递 `x-session-id`，从而让 subagent 流量保留正确的根会话以及 agent/user 语义。
- **通过 `@ai-sdk/anthropic` 接入 OpenCode**：可以将 OpenCode 指向这个代理作为 Anthropic provider，从而端到端保留 Anthropic Messages 语义、premium request 优化以及更原生的 Claude 行为。
- **Claude Code 集成**：可通过简单的命令行参数（`--claude-code`）快速配置并启动 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) 使用 Copilot 作为后端。
- **使用量看板**：提供基于 Web 的看板，用于监控 Copilot API 使用情况、查看额度以及详细统计数据。
- **速率限制控制**：通过速率限制选项（`--rate-limit`）和等待机制（`--wait`）管理 API 使用，避免因请求过快而报错。
- **手动请求审批**：可对每个 API 请求进行手动批准或拒绝，实现更细粒度的使用控制（`--manual`）。
- **令牌可见性**：可在认证和刷新期间显示 GitHub 与 Copilot token，便于调试（`--show-token`）。
- **灵活认证方式**：既可交互式认证，也可以直接传入 GitHub token，适合 CI/CD 等非交互环境。
- **支持不同账号类型**：兼容个人版、Business 和 Enterprise 的 GitHub Copilot 方案。
- **支持 opencode OAuth**：可通过设置环境变量 `COPILOT_API_OAUTH_APP=opencode` 或使用命令行参数 `--oauth-app=opencode` 来启用 opencode GitHub Copilot 认证。
- **支持 GitHub Enterprise**：可通过设置环境变量 `COPILOT_API_ENTERPRISE_URL`（例如 `company.ghe.com`）或命令行参数 `--enterprise-url=company.ghe.com` 连接到 GHE.com。
- **自定义数据目录**：可通过环境变量 `COPILOT_API_HOME` 或命令行参数 `--api-home=/path/to/dir` 修改默认数据目录（存放 token 和配置）。
- **多 Provider Anthropic 代理路由**：可以添加全局 provider 配置，并通过 `/:provider/v1/messages` 与 `/:provider/v1/models` 调用外部 Anthropic 兼容 API。
- **精确的 Claude Token 计数**：可以选择将 Claude 模型的 `/v1/messages/count_tokens` 请求转发到 Anthropic 的免费 token counting 端点，以获得精确计数，而不是依赖 GPT tokenizer 估算。
- **GPT 上下文管理**：可通过 `responsesApiContextManagementModels` 为长上下文 GPT 对话启用可配置的上下文压缩，在接近 token 限制时减少不必要的 Premium 请求。详见 [配置](#configuration-configjson)。

## 更好的 Agent 语义

### 在可用时优先使用原生 Anthropic Messages API

对于那些声明支持 Copilot `/v1/messages` 的模型，本项目会优先把请求发送到原生 Messages API，只有在需要时才回退到 `/responses` 或 `/chat/completions`。

相比仅通过 Chat Completions 兼容层使用 Claude 系模型，Messages API 路径能保留更多 Anthropic 原生行为，包括支持：

- `interleaved-thinking-2025-05-14`
- `advanced-tool-use-2025-11-20`
- `context-management-2025-06-27`

支持的 `anthropic-beta` 值会在原生 Messages 路径中过滤并透传；当请求了非自适应扩展思考的 thinking budget 时，也会自动添加 `interleaved-thinking`。

### 减少不必要的 Premium 请求

这个代理内置了一些请求计费保护逻辑，专门面向重工具调用的编码工作流：

- 无工具的预热或探测请求可以强制走 `smallModel`，避免后台检查消耗 premium 使用量；
- 混合了 `tool_result` 和补充提示文本的消息块会重新并入 `tool_result` 流，而不会被当成新的用户轮次计费；
- `x-initiator` 会根据最新一条消息或 item 推导，而不是依赖陈旧的 assistant 历史。

这样可以让恢复的工具轮次被视为既有工作流的延续，而不是一条全新的 Premium 请求。

### 分阶段的 `gpt-5.4` 与 `gpt-5.3-codex`

默认情况下，内置的 `extraPrompts` 会为 `gpt-5.4` 与 `gpt-5.3-codex` 启用中间进度更新行为，代理会在工具调用前把 assistant 轮次翻译成 `phase: "commentary"`，并在最终回复时使用 `phase: "final_answer"`。

这样客户端在更深入的推理或工具执行开始前，就能先收到一段简短、面向用户的说明。

### Subagent 标记集成

对于基于 subagent 的客户端，本项目可以保留根会话上下文，并正确识别来自 subagent 的流量。

这一标记流程会在 `<system-reminder>` 中放入 `__SUBAGENT_MARKER__...`，同时传递根级 `x-session-id`。当检测到该标记后，代理可以保留父会话身份、推导 `x-initiator: agent`，并把交互标记为 subagent 流量，而不是新的顶层请求。

项目中已经为 Claude Code 和 opencode 都提供了插件集成；配置方法见下文 [插件集成](#plugin-integrations)。

<a id="accurate-claude-token-counting"></a>

### 精确的 Claude Token 计数

默认情况下，`/v1/messages/count_tokens` 会使用 GPT 的 `o200k_base` tokenizer，并乘以 1.15 倍来估算 Claude token 数。这个估算通常会低于 Claude 的真实 token 使用量，导致像 Claude Code 这类工具压缩上下文太晚，从而触发 “prompt token count exceeds limit” 之类的错误。

当配置了 Anthropic API key 后，代理会把 Claude 模型的 token 计数请求转发到 [Anthropic 真实的 `/v1/messages/count_tokens` 端点](https://docs.anthropic.com/en/docs/build-with-claude/token-counting)。这样能返回精确计数，消除估算误差。不属于 Claude 的模型，以及转发失败的情况，会自动回退到 GPT tokenizer 估算。

**设置方式：**

1. 在 [console.anthropic.com](https://console.anthropic.com) 创建 Anthropic API 账户，并至少充值 5 美元信用额度（这是激活 API key 所需条件，但 token counting 端点本身是免费的）
2. 在 Settings > API Keys 中创建一个 API key
3. 通过以下 **任一** 方式配置：
   - `config.json`：设置 `"anthropicApiKey": "sk-ant-..."`
   - 环境变量：`ANTHROPIC_API_KEY=sk-ant-...`

> [!NOTE]
> Anthropic 的 `/v1/messages/count_tokens` 端点是 **免费的**（不会按 token 收费）。在 Tier 1 下速率限制为 100 RPM。这里要求预充值 5 美元，只是为了激活 API 访问权限，token counting 调用本身不产生费用。

## 前置要求

- Bun（>= 1.2.x）
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

## 配合 Docker 使用

构建镜像：

```sh
docker build -t copilot-api .
```

运行容器：

```sh
# 在宿主机创建目录，用于持久化 GitHub token 及相关数据
mkdir -p ./copilot-data

# 通过 bind mount 持久化 token
# 这样容器重启后认证信息仍会保留

docker run -p 4141:4141 -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api
```

> **注意：**
> GitHub token 及相关数据会保存在宿主机的 `copilot-data` 目录中。该目录会映射到容器内的 `/root/.local/share/copilot-api`，从而在容器重启后继续保留数据。

### 在 Docker 中使用环境变量

你也可以直接通过环境变量把 GitHub token 传给容器：

```sh
# 构建时注入 GitHub token
docker build --build-arg GH_TOKEN=your_github_token_here -t copilot-api .

# 运行时注入 GitHub token
docker run -p 4141:4141 -e GH_TOKEN=your_github_token_here copilot-api

# 搭配附加选项运行
docker run -p 4141:4141 -e GH_TOKEN=your_token copilot-api start --verbose --port 4141
```

### Docker Compose 示例

```yaml
version: "3.8"
services:
  copilot-api:
    build: .
    ports:
      - "4141:4141"
    environment:
      - GH_TOKEN=your_github_token_here
    restart: unless-stopped
```

Docker 镜像包含：

- 多阶段构建，以优化镜像体积
- 非 root 用户，以增强安全性
- 用于容器监控的健康检查
- 固定基础镜像版本，以保证可复现构建

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
      "apiKeys": []
    },
    "providers": {
      "custom": {
        "type": "anthropic",
        "enabled": true,
        "baseUrl": "your-base-url",
        "apiKey": "sk-your-provider-key",
        "authType": "x-api-key",
        "adjustInputTokens": false,
        "models": {
          "kimi-k2.5": {
            "temperature": 1,
            "topP": 0.95
          }
        }
      }
    },
    "extraPrompts": {
      "gpt-5-mini": "<built-in exploration prompt>",
      "gpt-5.3-codex": "<built-in commentary prompt>",
      "gpt-5.4-mini": "<built-in commentary prompt>",
      "gpt-5.4": "<built-in commentary prompt>"
    },
    "smallModel": "gpt-5-mini",
    "responsesApiContextManagementModels": [],
    "modelReasoningEfforts": {
      "gpt-5-mini": "low",
      "gpt-5.3-codex": "xhigh",
      "gpt-5.4-mini": "xhigh",
      "gpt-5.4": "xhigh"
    },
    "useFunctionApplyPatch": true,
    "useMessagesApi": true,
    "useResponsesApiWebSearch": true
  }
  ```
- **auth.apiKeys：** 用于请求认证的 API key。支持多个 key 轮换使用。请求可通过 `x-api-key: <key>` 或 `Authorization: Bearer <key>` 进行认证。若为空或省略，则禁用认证。
- **extraPrompts：** `model -> prompt` 的映射。把 Anthropic 风格请求翻译给 Copilot 时，会将其附加到第一条 system prompt 后面。你可以借此为不同模型注入护栏或指引。缺失的默认项会自动补齐，但不会覆盖你自定义的 prompt。内置的 `gpt-5.3-codex` 和 `gpt-5.4` prompt 会启用带阶段感知的 commentary，让模型在工具调用或更深层推理前先发出简短的用户可见进度说明。
- **providers：** 全局上游 provider 映射。每个 provider key（例如 `custom`）都会变成一个路由前缀（`/custom/v1/messages`）。目前仅支持 `type: "anthropic"`。
  - `enabled`：可选，若省略则默认为 `true`。
  - `baseUrl`：provider API 的基础 URL，不要带结尾的 `/v1/messages`。
  - `apiKey`：作为上游凭据值使用。
  - `authType`：可选，控制 `apiKey` 如何发送到上游。支持 `x-api-key`（默认）和 `authorization`。当设置为 `authorization` 时，代理会发送 `Authorization: Bearer <apiKey>`。
  - `adjustInputTokens`：可选，当为 `true` 时，代理会在 usage 响应里用 `input_tokens` 减去 `cache_read_input_tokens` 和 `cache_creation_input_tokens`。
  - `models`：可选，按模型 ID 配置的映射。每个键为请求中的模型名，值支持：
    - `temperature`：可选，当请求未指定时使用的默认温度。
    - `topP`：可选，当请求未指定时使用的默认 `top_p`。
    - `topK`：可选，当请求未指定时使用的默认 `top_k`。
- **smallModel：** 无工具预热消息的回退模型（例如 Claude Code 的探测请求），用于避免消耗 premium requests；默认是 `gpt-5-mini`。
- **responsesApiContextManagementModels：** 需要启用 Responses API `context_management` 压缩指令的 GPT 模型 ID 列表。默认是 `[]`，需要你显式开启。一个不错的起点是 `["gpt-5-mini", "gpt-5.3-codex", "gpt-5.4-mini", "gpt-5.4"]`。启用后，请求体会带上 `context_management`，并在后续轮次中仅保留最新的压缩承载内容。实际压缩由服务端完成，看起来会在 usage 接近模型 `maxPromptTokens` 的约 90% 时开始，因此特别适合长任务场景，同时不会额外消耗 premium requests。实践中 `compact_threshold` 似乎也是服务端固定的，所以在本项目中修改它目前不会改变压缩行为。当前该优化仅面向 GPT 系模型。
- **modelReasoningEfforts：** 按模型配置发送到 Copilot Responses API 的 `reasoning.effort`。可选值包括 `none`、`minimal`、`low`、`medium`、`high` 和 `xhigh`。若某模型未配置，则默认使用 `high`。
- **useFunctionApplyPatch：** 当为 `true` 时，服务端会把 Responses payload 中任何名为 `apply_patch` 的自定义工具转换为 OpenAI 风格的函数工具（`type: "function"`），并附带参数 schema，从而让 assistant 可以通过 function-calling 语义调用它来编辑文件。若设为 `false`，则保持工具原样。默认值为 `true`。
- **useMessagesApi：** 当为 `true` 时，支持 Copilot 原生 `/v1/messages` 的 Claude 系模型会走 Messages API；否则回退到 `/chat/completions`。设为 `false` 可禁用 Messages API 路由，始终使用 `/chat/completions`。默认值为 `true`。
- **useResponsesApiWebSearch：** 当为 `true` 时，服务端会保留 Responses API 中 `type: "web_search"` 的工具并透传到上游。设为 `false` 则会从 `/responses` payload 中移除这些工具。默认值为 `true`。
- **claudeTokenMultiplier：** 用于 Claude `/v1/messages/count_tokens` 请求在本地走 GPT tokenizer 估算时的乘数。默认值为 `1.15`。如果你的客户端仍然过晚触发上下文压缩，可以适当调大。这个配置只会在代理本地估算 Claude token 时生效；如果已经配置 `anthropicApiKey` 且 Anthropic token counting 调用成功，则会直接返回 Anthropic 的精确计数，不会使用这个乘数。
- **anthropicApiKey：** 用于精确 Claude token 计数的 Anthropic API key（参见下方 [精确的 Claude Token 计数](#accurate-claude-token-counting)）。也可通过环境变量 `ANTHROPIC_API_KEY` 设置。若未配置，则回退到 GPT tokenizer 估算。

编辑此文件后即可自定义 prompts，或替换为你自己的快速模型。修改完成后请重启服务（或重新执行命令），让缓存中的配置刷新生效。

## API 认证

- **受保护路由：** 当配置了 `auth.apiKeys` 且非空时，除 `/`、`/usage-viewer` 和 `/usage-viewer/` 以外的所有路由都需要认证。
- **允许的认证头：**
  - `x-api-key: <your_key>`
  - `Authorization: Bearer <your_key>`
- **CORS 预检：** `OPTIONS` 请求始终允许。
- **未配置 key 时：** 服务会正常启动，并允许请求通过（即禁用认证）。

示例请求：

```sh
curl http://localhost:4141/v1/models \
  -H "x-api-key: your_api_key"
```

## API 端点

服务端提供多个端点来与 Copilot API 交互。它支持 OpenAI 兼容端点，也支持 Anthropic 兼容端点，因此可以更灵活地接入不同工具与服务。

### OpenAI 兼容端点

这些端点模拟 OpenAI API 结构。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `POST /v1/responses` | `POST` | OpenAI 中用于生成模型响应的高级接口。 |
| `POST /v1/chat/completions` | `POST` | 为给定聊天对话创建模型响应。 |
| `GET /v1/models` | `GET` | 列出当前可用模型。 |
| `POST /v1/embeddings` | `POST` | 创建表示输入文本的向量嵌入。 |

### Anthropic 兼容端点

这些端点设计为兼容 Anthropic Messages API。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `POST /v1/messages` | `POST` | 为给定对话创建模型响应。 |
| `POST /v1/messages/count_tokens` | `POST` | 计算一组消息的 token 数。 |
| `POST /:provider/v1/messages` | `POST` | 将 Anthropic Messages API 代理到已配置的 provider。 |
| `GET /:provider/v1/models` | `GET` | 将 Anthropic Models API 代理到已配置的 provider。 |
| `POST /:provider/v1/messages/count_tokens` | `POST` | 为 provider 路由请求在本地计算 token 数。 |

### 使用量监控端点

用于监控 Copilot 用量与额度的新端点。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `GET /usage` | `GET` | 获取详细的 Copilot 使用统计与额度信息。 |
| `GET /token` | `GET` | 获取当前 API 正在使用的 Copilot token。 |

## 使用示例

通过 npx 使用：

```sh
# 基础启动
npx @jeffreycao/copilot-api@latest start

# 自定义端口并开启详细日志
npx @jeffreycao/copilot-api@latest start --port 8080 --verbose

# 使用 GitHub Business 方案账号
npx @jeffreycao/copilot-api@latest start --account-type business

# 使用 GitHub Enterprise 方案账号
npx @jeffreycao/copilot-api@latest start --account-type enterprise

# 对每个请求启用手动审批
npx @jeffreycao/copilot-api@latest start --manual

# 将请求间隔限制为 30 秒
npx @jeffreycao/copilot-api@latest start --rate-limit 30

# 命中速率限制时等待，而不是直接报错
npx @jeffreycao/copilot-api@latest start --rate-limit 30 --wait

# 直接传入 GitHub token
npx @jeffreycao/copilot-api@latest start --github-token ghp_YOUR_TOKEN_HERE

# 仅执行认证流程
npx @jeffreycao/copilot-api@latest auth

# 认证时启用详细日志
npx @jeffreycao/copilot-api@latest auth --verbose

# 在终端中查看 Copilot 用量与额度（无需启动服务）
npx @jeffreycao/copilot-api@latest check-usage

# 输出调试信息，便于排障
npx @jeffreycao/copilot-api@latest debug

# 以 JSON 格式输出调试信息
npx @jeffreycao/copilot-api@latest debug --json

# 从环境变量初始化代理（HTTP_PROXY、HTTPS_PROXY 等）
npx @jeffreycao/copilot-api@latest start --proxy-env

# 使用 opencode GitHub Copilot 认证
COPILOT_API_OAUTH_APP=opencode npx @jeffreycao/copilot-api@latest start

# 通过命令行设置自定义 API home 目录
npx @jeffreycao/copilot-api@latest --api-home=/path/to/custom/dir start

# 通过命令行使用 GitHub Enterprise
npx @jeffreycao/copilot-api@latest --enterprise-url=company.ghe.com start

# 通过命令行使用 opencode OAuth
npx @jeffreycao/copilot-api@latest --oauth-app=opencode start

# 组合多个全局选项
npx @jeffreycao/copilot-api@latest --api-home=/custom/path --oauth-app=opencode --enterprise-url=company.ghe.com start
```

## 与 OpenCode 一起使用

OpenCode 已经有直接的 GitHub Copilot provider。本节适用于你希望让 OpenCode 通过 `@ai-sdk/anthropic` 指向这个代理，并复用本 README 前面提到的 agent 行为时。

### 最小配置

使用 OpenCode OAuth app 启动代理：

```sh
npx @jeffreycao/copilot-api@latest --oauth-app=opencode start
```

然后让 OpenCode 通过 `@ai-sdk/anthropic` 指向该代理。

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
            "context": 272000,
            "output": 128000
          }
        },
        "gpt-5-mini": {
          "name": "gpt-5-mini",
          "limit": {
            "context": 128000,
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
            "context": 128000,
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

- `npm: "@ai-sdk/anthropic"` 是关键。OpenCode 会以 Anthropic Messages 语义与该代理通信，而不是把一切扁平化为 OpenAI Chat Completions。
- `options.baseURL` 应设为 `http://localhost:4141/v1`；Anthropic SDK 会自动补上 `/messages`、`/models` 和 `/messages/count_tokens`。
- `model`、`small_model` 与 `agent.*.model` 让你可以把 `gpt-5.4` 用于 build/plan，同时把探索和后台工作路由到 `gpt-5-mini`。
- 如果你在此代理中启用了 `auth.apiKeys`，请把 `dummy` 替换为真实 key；否则任意占位值都可以。

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

- **API Endpoint URL**：看板会通过 URL 查询参数，默认从本地服务端点拉取数据。你也可以把这个 URL 改成任意其他兼容 API 端点。
- **Fetch Data**：点击 “Fetch” 按钮即可加载或刷新使用数据。页面首次加载时也会自动拉取。
- **Usage Quotas**：使用进度条汇总展示 Chat、Completions 等不同服务的额度使用情况。
- **Detailed Information**：可查看 API 返回的完整 JSON，以便深入分析所有可用统计信息。
- **URL-based Configuration**：你也可以直接通过 URL 查询参数指定 API 端点，便于收藏或分享。例如：
  `http://localhost:4141/usage-viewer?endpoint=http://your-api-server/usage`

## 与 Claude Code 一起使用

这个代理可以为 [Claude Code](https://docs.anthropic.com/en/claude-code) 提供后端能力。Claude Code 是 Anthropic 提供的实验性面向开发者的对话式 AI 助手。

有两种方式可以把 Claude Code 配置为使用这个代理：

### 通过 `--claude-code` 标志进行交互式配置

执行带 `--claude-code` 的 `start` 命令开始：

```sh
npx @jeffreycao/copilot-api@latest start --claude-code
```

你会被提示选择一个主模型，以及一个用于后台任务的 “small, fast” 模型。选择完成后，会有一条命令被复制到剪贴板中。该命令会设置 Claude Code 使用该代理所需的环境变量。

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
      "WebSearch", 
      "mcp__ide__executeCode"
    ]
  }
}
```

- 请根据需要替换 `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL` 和 `ANTHROPIC_DEFAULT_HAIKU_MODEL`。配置完成后，请安装 claude code 插件，见 [插件集成](#plugin-integrations)。如果你配置的是 Claude 模型，建议把这些模型配置都设为相同，以保持与 github-copilot claude agent 行为一致。
- 将 `CLAUDE_CODE_ATTRIBUTION_HEADER` 设为 `0` 可以阻止 Claude Code 在 system prompt 中附加计费和版本信息，从而避免 prompt cache 失效。
- 关闭 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` 和 `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` 可以避免不必要地消耗额度。
- `permissions` 中禁止 `WebSearch`，因为 GitHub Copilot API 不支持原生 web search（部分 gpt 模型支持 websearch，但本项目目前尚未适配）；建议安装 mcp 的 `mcp_server_fetch` 工具或其他搜索工具作为替代。
- 如果使用的不是 Claude 模型，请不要启用 `ENABLE_TOOL_SEARCH`。如果使用的是 Claude 模型，则可以启用 `ENABLE_TOOL_SEARCH`。当前 Claude Code 使用的是客户端 tool search 模式，在该模式下每次加载 defer tools 都需要额外请求一次。

更多选项见：[Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

也可以参考 IDE 集成说明：[Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

<a id="plugin-integrations"></a>

## 插件集成

本项目为 Claude Code 和 opencode 提供了插件集成。

#### Claude Code 插件集成（基于 marketplace）

Claude Code 集成被打包为名为 `claude-plugin` 的插件。

- 本仓库中的 marketplace catalog：`.claude-plugin/marketplace.json`
- 本仓库中的插件源码：`claude-plugin`

远程添加 marketplace：

```sh
/plugin marketplace add https://github.com/caozhiyuan/copilot-api.git
```

从 marketplace 安装插件：

```sh
/plugin install claude-plugin@copilot-api-marketplace
```

安装后，插件会在 `SubagentStart` 时注入 `__SUBAGENT_MARKER__...`，该代理会利用它推导 `x-initiator: agent`。

插件还会注册一个 `UserPromptSubmit` hook，并返回 `{"continue": true}`；同时它也可以通过环境变量注入 `SessionStart` reminder 规则：

- `CLAUDE_PLUGIN_ENABLE_QUESTION_RULES=1` 会自动为 Claude Code 启用两条关于使用 `question` 工具的提醒。你也可以把同样的提醒手动写进 `CLAUDE.md`；见 [CLAUDE.md 或 AGENTS.md 推荐内容](#claudemd-or-agentsmd-recommended-content)。
- `CLAUDE_PLUGIN_ENABLE_NO_BACKGROUND_AGENTS_RULE=1` 会启用关于避免在 agent hooks 中使用 `run_in_background: true` 的提醒。

#### Opencode 插件

subagent 标记生成器被打包为一个 opencode 插件，位于 `.opencode/plugins/subagent-marker.js`。

**安装方式：**

将插件文件复制到你的 opencode 插件目录：

```sh
# 克隆或下载本仓库后复制该插件
cp .opencode/plugins/subagent-marker.js ~/.config/opencode/plugins/
```

或者手动在 `~/.config/opencode/plugins/subagent-marker.js` 创建该文件，并填入插件内容。

**功能：**

- 跟踪 subagent 创建的子会话
- 自动在 subagent 聊天消息前添加 marker system reminder（`__SUBAGENT_MARKER__...`）
- 设置 `x-session-id` 请求头以跟踪会话
- 让该代理能够把来自 subagent 的请求识别为 `x-initiator: agent`

该插件会挂接到 `session.created`、`session.deleted`、`chat.message` 和 `chat.headers` 事件上，以无缝提供 subagent marker 能力。

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
