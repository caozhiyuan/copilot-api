# 安装与启动

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/getting-started.md)

<a id="project-overview"></a>

## 项目概览

这是一个小型 AI gateway，可以使用 GitHub Copilot、内置 `codex` provider，也可以使用 DashScope 等已配置的第三方 provider。GitHub Copilot 现在是可选能力：如果本地没有 GitHub token，只要至少配置了一个启用中的 provider，服务仍可按 provider-only 模式启动。

AI gateway 会从同一个本地端点暴露 OpenAI / Anthropic 兼容 API，让 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)、OpenCode、Codex 和 OpenAI 兼容客户端可以共用同一个本地服务。

在 GitHub Copilot 路径上，AI gateway 会在可用时优先使用 Copilot 原生的 Anthropic 风格 Messages API，在重工具调用场景下保留更原生的 Claude 行为。

<a id="important-notes"></a>

## 重要说明

> [!IMPORTANT]
> **使用前请先注意以下几点：**
>
> 1. **Codex 配置：** 与 Codex 搭配使用时，请在 `~/.codex/config.toml` 中添加 gateway provider，详见 [Codex `config.toml` 参考配置](codex.md#codex-configtoml-参考配置)。
>
> 2. **Claude Code 配置：** 与 Claude Code 搭配使用时，请将模型 ID 配置为 `claude-opus-4-8[1m]`。示例 claude `settings.json` 见 [通过 `settings.json` 手动配置](claude-code.md#manual-configuration-with-settingsjson)。
>
> 3. **OpenCode 配置：** 与 OpenCode 搭配使用时，请使用 `@ai-sdk/anthropic` 配置 `~/.config/opencode/opencode.json`，详见 [与 OpenCode 一起使用](opencode.md#与-opencode-一起使用)。
>
> 4. **内置 `copilot`、`codex` 与第三方 provider：** 执行 `bunx --bun @jeffreycao/copilot-api auth`，可选择 `copilot`、`codex`、`deepseek`、`custom` 等 provider。
>
> 5. **注意事项：** 使用 GitHub Copilot 前请阅读 [GitHub Copilot 安全提示](../../../NOTICE.md#github-copilot-security-notice)。

<a id="prerequisites"></a>

## 前置要求

- Bun >= 1.4.0（推荐）
- 如果要通过 `npx` 运行已发布 CLI，需要 Node.js >= 22.13.0
- 只有在使用 GitHub Copilot provider 时，才需要已订阅 Copilot 的 GitHub 账号
- 如果不使用 GitHub Copilot，需要至少一个已配置 provider 的 API key 或 OAuth 登录

<a id="installation"></a>

## 安装

安装依赖：

```sh
bun install
```

<a id="running-from-source"></a>

## 从源码运行

> [!NOTE]
> 使用 `tsdown@0.23` 从源码构建时，需要 Node.js `^22.18.0 || ^24.11.0 || >=26.0.0`。这只是构建期要求；已发布 CLI 的运行时要求仍为 Node.js >= 22.13.0。

本项目可以通过多种方式从源码运行：

### 开发模式

```sh
bun run dev start
```

### 生产模式

```sh
bun run start start
```

> 结尾的 `start` 是传给 `src/main.ts` 的 CLI 子命令，不是笔误：`bun run dev start` 是 watch 模式，`bun run start start` 是生产模式。

<a id="using-with-bun"></a>

## 使用 Bun 运行 npm 包（推荐）

安装 [Bun >= 1.4.0](https://bun.sh/docs/installation)，即可直接运行已发布的 npm 包：

```sh
bunx --bun @jeffreycao/copilot-api start
```

`--bun` 不能省略：包使用 Node shebang，直接执行 `bunx` 仍可能启动 Node.js。使用 Bun 运行已发布包不需要额外安装 Node.js。

频繁使用时，也可以先全局安装，再明确使用 Bun 执行已安装的 CLI：

```sh
bun add --global @jeffreycao/copilot-api
bun run --bun copilot-api start
```

请将 Bun 的全局可执行目录（`bun pm bin -g`）加入 `PATH`。直接执行 `copilot-api start` 会遵循 Node shebang；使用 `bun run --bun` 才会保持 Bun 运行时。

### 缓存与升级

日常 `bunx` 启动建议不带 `@latest`；需要固定版本时可写明确版本号。在 Linux、Bun 1.4.0 上连续执行 `--help` 实测，带 `@latest` 每次都会重新进入依赖解析，不带后缀或固定版本的后续运行则复用缓存、没有安装输出。重新进入安装流程不代表全部依赖都会重新下载，缓存过期及 Bun 版本也可能影响该行为。

需要升级时，再明确指定最新版本：

```sh
# bunx：升级时解析最新版本，日常启动再省略 @latest
bunx --bun @jeffreycao/copilot-api@latest start

# 全局安装：更新一次，之后直接运行已安装的 CLI
bun add --global @jeffreycao/copilot-api@latest
bun run --bun copilot-api start
```

运行时选择与缓存机制详见 [Bun 的 bunx 文档](https://bun.sh/docs/pm/bunx)。

带参数示例：

```sh
bunx --bun @jeffreycao/copilot-api auth keys --add your-gateway-api-key
bunx --bun @jeffreycao/copilot-api start --host 0.0.0.0 --port 8080
```

绑定到 `0.0.0.0` 会将网关暴露到网络，因此服务要求至少配置一个网关 API Key，并将 CORS 限制为同源请求。

如果只想做认证或 provider 配置：

```sh
bunx --bun @jeffreycao/copilot-api auth
```

如果要不依赖 GitHub Copilot 运行，先配置至少一个 provider，然后正常启动服务：

```sh
bunx --bun @jeffreycao/copilot-api auth login --provider dashscope
bunx --bun @jeffreycao/copilot-api start
```

<a id="using-with-npx"></a>

## 通过 npx 使用

也支持 Node.js >= 22.13.0：

```sh
npx @jeffreycao/copilot-api@latest start
```

token usage 存储使用 Node 内置的 `node:sqlite`，Node.js 22.13.0 起无需 `--experimental-sqlite`；Bun 则使用 `bun:sqlite`。
