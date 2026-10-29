# Copilot API

<p align="center">
  <img src="docs/hero/copilot-api-hero.svg" alt="Copilot API - Universal AI Gateway" width="1600" />
</p>

<p align="center">
  <strong>Universal AI Gateway</strong><br />
  One Gateway. Any Client. Multiple AI Providers.<br />
  Chat Completions &middot; OpenAI Responses &middot; Anthropic Messages
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jeffreycao/copilot-api"><img src="https://img.shields.io/npm/v/@jeffreycao/copilot-api.svg" alt="npm version"></a>
  <a href="https://github.com/caozhiyuan/copilot-api/blob/dev/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/caozhiyuan/copilot-api/stargazers"><img src="https://img.shields.io/github/stars/caozhiyuan/copilot-api.svg" alt="GitHub stars"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-%3E%3D1.4.4-orange.svg" alt="Bun >= 1.4.4"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node-22%20%7C%2024%20%7C%2026-green.svg" alt="Node.js 22、24 或 26，需安装安全更新"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

Copilot API 是一个本地 AI 网关，让 Claude Code、OpenCode、Codex 等客户端通过统一的 API 使用 GitHub Copilot、内置 Codex、xAI 和第三方模型服务。

<a id="highlights"></a>

## 功能亮点

- **统一 API 网关**：在同一个本地端点上提供 OpenAI 兼容的 Chat Completions（`/v1/chat/completions`）、OpenAI Responses API（`/v1/responses`）和 Anthropic 兼容的 Messages（`/v1/messages`）。
- **多 Provider 接入**：在同一个网关后面统一路由 GitHub Copilot、内置 `codex`、`xai` provider 和第三方 provider（Kimi、DeepSeek、DashScope、OpenRouter、OpenCode Go、Google Gemini 或从 models.dev 选择的自定义 provider）。GitHub Copilot 是可选能力——只要至少有一个启用中的 provider，无需 GitHub token 也能按 provider-only 模式启动。
- **为 Coding Agent 而生**：为 Claude Code、OpenCode 和 Codex 提供完整的配置指南，包括 settings.json 网关模型发现和面向 Codex 的合并模型目录。
- **Streaming 与 WebSocket**：三种面向客户端的协议都支持 SSE 流式输出。上游 Copilot Responses 流量会根据每个模型声明的端点选择 WebSocket 或 HTTP；内置 `codex` provider 的流式 Responses 请求默认走 WebSocket，关闭 `useResponsesApiWebSocket` 后改走 HTTP。
- **桌面应用**：Electron 图形界面，支持 GitHub Copilot 登录、Codex 与 xAI OAuth、provider 配置、token 用量、日志查看和一键启动 / 停止。

<a id="quick-start"></a>

## 快速开始

请使用已安装下述安全更新的 **Node.js 22.x、24.x 或 26.x**（npx），或 **Bun >= 1.4.4**。使用 GitHub Copilot 时需要相应订阅；也可以配置其他 provider 独立运行。

> [!WARNING]
> **CVE-2026-111497 安全提示：** 受影响的 Node.js 和 Bun 内置 Brotli 解码器存在内存破坏及远程代码执行风险。请将 Node.js 22.x 升级至 **22.23.4 或更高版本**、24.x 升级至 **24.22.1 或更高版本**，或 26.x 升级至 **26.12.1 或更高版本**；Bun 请升级至 **1.4.4 或更高版本**。升级后重启网关；Docker 部署请使用修复后的运行时重新构建并部署镜像。详见 [Node.js 安全公告](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)和 [Bun 安全公告](https://github.com/oven-sh/bun/security/advisories/GHSA-663w-cv8g-jj2p)。

```sh
npx @jeffreycao/copilot-api@latest start
```

服务默认监听 `http://localhost:4141`。也可以先登录 GitHub Copilot 或配置第三方 provider：

```sh
npx @jeffreycao/copilot-api@latest auth login
```

也可以使用 Bun >= 1.4.4 运行，可获得更好的性能：

```sh
bunx --bun @jeffreycao/copilot-api start
```

`--bun` 用于选择 Bun 运行时，日常启动省略 `@latest` 以复用缓存。全局安装与升级方式见 [Bun 使用说明](docs/guides/zh-CN/getting-started.md#using-with-bun)。

> [!NOTE]
> 如需信任系统安装的 CA 证书（例如使用企业 HTTPS 代理时），`npx` 无需额外设置：Node.js >= 22.19.0 启动时会通过 [`tls.setDefaultCACertificates()`](https://nodejs.org/api/tls.html#tlssetdefaultcacertificatescerts) 自动合并系统 CA 证书。只有 Bun 需要在运行 `bunx --bun` 前设置 `NODE_USE_SYSTEM_CA=1`：bash/zsh 使用 `export NODE_USE_SYSTEM_CA=1`，PowerShell 使用 `$env:NODE_USE_SYSTEM_CA="1"`（Bun >= 1.4.4）。
> Desktop 默认对子进程启用此设置，并保留显式配置的环境变量。

验证网关已启动：

```sh
curl http://localhost:4141/v1/models
```

> [!NOTE]
> token usage 存储需要 Node.js >= 22.13.0 或 Bun。详见[通过 npx 使用](docs/guides/zh-CN/getting-started.md#using-with-npx)。

接下来可按你的客户端选择指南：[与 Claude Code 一起使用](docs/guides/zh-CN/claude-code.md#using-with-claude-code)、[与 OpenCode 一起使用](docs/guides/zh-CN/opencode.md#using-with-opencode)、[与 Codex 一起使用](docs/guides/zh-CN/codex.md#using-with-codex)、[与 DeepSeek Harness 一起使用](docs/guides/zh-CN/dsh.md#using-with-deepseek-harness)，或通过 [Docker](docs/guides/zh-CN/docker.md#using-with-docker) 运行。

<a id="compatibility"></a>

## 兼容性

所有客户端都访问同一个本地端点。网关会把每个请求路由到 GitHub Copilot、内置 `codex`、`xai` provider 或已配置的第三方 provider，并在 provider 使用不同协议时进行协议翻译。

**客户端 / 协议矩阵**

| 客户端 | Chat Completions | Responses | Anthropic Messages | 推荐 |
|---|:---:|:---:|:---:|---|
| Claude Code | — | — | ✅ 原生 / 适配 | Anthropic Messages |
| OpenCode | ✅ 原生 | ✅ 原生 / 适配 | ✅ 原生 / 适配 | Anthropic Messages |
| Codex | — | ✅ 原生 / 适配 | — | Responses |
| DeepSeek Harness | — | ✅ 原生 / 适配 | ✅ 原生 / 适配 | Responses |
| OpenAI 兼容客户端 | ✅ 原生 | ✅ 原生 / 适配 | — | Chat Completions |
| Anthropic 兼容客户端 | — | — | ✅ 原生 / 适配 | Anthropic Messages |

**Provider 与协议。** 协议能力按模型决定。Chat Completions 必须使用原生端点，Responses 和 Messages 则可在存在受支持路径时进行适配。内置 `codex` provider 原生使用 Responses；第三方 provider 可选择 `anthropic`、`openai-compatible` 或 `openai-responses`，也可按模型覆盖。

<a id="desktop-app"></a>

## 桌面应用

更喜欢图形界面？`desktop/` 目录下的 Electron 桌面应用支持 GitHub Copilot 登录、OpenAI Codex 与 xAI OAuth，以及 Kimi、DeepSeek、DashScope、OpenRouter 或从 models.dev 选择的自定义 provider 的 API Key 配置——可以一键启动 / 停止本地服务，并在一个窗口里查看本地端点、鉴权 Header、可用模型、用量和日志。

<p align="center">
  <img src="docs/screenshots/desktop-dashboard.png" alt="Copilot API 桌面应用首页" width="49%" />
  <img src="docs/screenshots/desktop-token-usage.png" alt="Copilot API 桌面应用 Token 用量页" width="49%" />
</p>

Windows x64（`.exe`）、macOS Apple Silicon（`.dmg`）和 Linux x64（`.AppImage`）安装包发布在 [GitHub Releases](https://github.com/caozhiyuan/copilot-api/releases)。完整配置与高级设置见 [Electron 桌面应用](docs/guides/zh-CN/desktop.md#electron-desktop-app)。

首次下载完整安装包安装后，后续更新通常会使用增量下载，减少下载量。macOS 首次更新若尚无 DMG 缓存，可能会先完整下载一次以建立缓存；缓存不可用或增量下载失败时，会自动回退完整下载。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [安装与启动](docs/guides/zh-CN/getting-started.md) | 环境要求、项目概览、npx 与源码运行、无 Copilot 时的 provider-only 模式，以及网关 API Key 配置 |
| [Claude Code](docs/guides/zh-CN/claude-code.md) | settings.json、网关模型发现、模型映射、自动压缩窗口与 WebSearch 行为 |
| [OpenCode](docs/guides/zh-CN/opencode.md) | v2 Responses 插件与自动模型发现、原生压缩、模型能力与价格、上下文上限，以及 v1 Anthropic SDK 配置 |
| [Codex](docs/guides/zh-CN/codex.md) | 完整的 `config.toml` provider 配置块、`GITHUB_COPILOT_API_KEY` 环境变量设置、自动审核模型映射、生成 `model_catalog.json`，以及合并后的模型选择器目录与协议适配 |
| [DeepSeek Harness](docs/guides/zh-CN/dsh.md) | 安装 `dsh-copilot-api`、保存网关 API 密钥，并选择 Responses 或 Messages |
| [Docker](docs/guides/zh-CN/docker.md) | Docker Compose 快速启动、`/data` 持久化挂载与属主修复、支持的环境变量，以及监听所有网卡地址 |
| [桌面应用](docs/guides/zh-CN/desktop.md) | Copilot 登录、Codex OAuth 账号切换、API Key provider、一键启停、共享模型映射、高级设置与各平台安装包 |
| [插件与工具搜索](docs/guides/zh-CN/integrations.md) | Responses `tool_search` MCP 桥接（opencode v2 已通过 Code Mode 延迟加载工具，不需要）、Claude Code 的 `agent-inject` 与 `tool-search` 市场插件，以及 opencode 子代理标记插件 |
| [用量监控](docs/guides/zh-CN/usage.md) | 用量面板地址与查询参数、时间范围选择、Copilot 配额进度、Token 与成本指标卡、趋势图，以及分页的请求事件列表 |
| [命令行参考](docs/guides/zh-CN/cli.md) | 命令结构、全局选项，以及 `start`、`auth`、`debug` 子命令的完整参数与使用示例 |
| [配置参考](docs/guides/zh-CN/configuration.md) | `config.json` 全部配置项：网关与管理 API Key、provider 定义、模型映射、WebSocket 与 HTTP 传输、超时与上下文管理 |
| [API 与认证](docs/guides/zh-CN/api.md) | 支持的认证请求头与 CORS 规则、OpenAI / Codex 后端 / Anthropic 端点、用量监控接口与管理配置接口 |
| [故障排查](docs/guides/zh-CN/troubleshooting.md) | Copilot 模型列表中缺少 Claude 模型的处理方法 |

使用 GitHub Copilot 前请阅读 [GitHub Copilot 安全提示](NOTICE.md#github-copilot-security-notice)。
