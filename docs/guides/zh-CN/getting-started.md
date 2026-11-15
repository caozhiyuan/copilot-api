# 安装与启动

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/getting-started.md)

<a id="project-overview"></a>

## 项目概览

Copilot API 把多个模型服务接到同一个本地地址。Claude Code、OpenCode、Codex 等客户端连接这个地址后，就能使用你已配置的模型。

模型服务在配置中称为 provider。你可以登录 GitHub Copilot、Codex 或 xAI，也可以填写 DeepSeek、DashScope 等服务的 API Key。不使用 GitHub Copilot 也能运行，只需配置并启用至少一个模型服务。

<a id="prerequisites"></a>

## 准备运行环境

- 推荐使用 Bun >= 1.4.4；通过 Bun 运行已发布的包，不需要另外安装 Node.js。
- 也可通过 npx 运行，Node.js 版本需满足 `^22.23.4 || ^24.22.1 || >=26.12.1`。
- 使用 GitHub Copilot 时，需要有相应订阅的 GitHub 账号；使用其他服务时，需要该服务的 API Key 或账号。

运行时安全更新说明见[项目首页](../../../README.zh-CN.md#quick-start)。

## 配置账号或 API Key

下面的命令使用 Bun。如果只安装了 Node.js，将 `bunx --bun @jeffreycao/copilot-api` 换成 `npx @jeffreycao/copilot-api@latest` 即可。

首次使用时，运行以下命令，按提示选择服务并完成登录或填写 API Key：

```sh
bunx --bun @jeffreycao/copilot-api auth login
```

例如，只使用 DashScope 时：

```sh
bunx --bun @jeffreycao/copilot-api auth login --provider dashscope
```

配置完成后，按下面的 Bun 或 npx 方式启动。默认配置下，首次直接运行 `start`，如果还没有可用的账号或模型服务，也会进入配置流程。使用 GitHub Copilot 前，请阅读[安全提示](../../../NOTICE.md#github-copilot-security-notice)。

<a id="using-with-bun"></a>

## 使用 Bun 运行 npm 包（推荐）

安装 [Bun >= 1.4.4](https://bun.sh/docs/installation)，即可直接运行已发布的 npm 包：

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

日常启动可以不带 `@latest`，复用已缓存的安装；需要固定版本时，写上明确版本号。升级时再加 `@latest`。实际缓存行为会随 Bun 版本和缓存有效期变化。

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

<a id="using-with-npx"></a>

## 通过 npx 使用

也支持 Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`：

```sh
npx @jeffreycao/copilot-api@latest start
```

Token 用量历史使用 Node 内置的 `node:sqlite`，Node.js 22.13.0 起无需 `--experimental-sqlite`；Bun 则使用 `bun:sqlite`。

<a id="important-notes"></a>

## 检查服务并连接客户端

启动后，访问模型列表，确认服务可以连接：

```sh
curl http://localhost:4141/v1/models
```

如果配置了网关 API Key，请在请求中加上 `x-api-key` 请求头。网关 API Key 用于客户端连接本地网关；模型服务的 API Key 用于网关连接对应服务，两者用途不同。管理网关密钥的方法见[命令行参考](cli.md#auth-命令选项)。

- **Claude Code**：在 `.claude/settings.json` 中设置网关地址和可用模型，见 [Claude Code 配置](claude-code.md#manual-configuration-with-settingsjson)。不要求使用某一个固定模型。
- **OpenCode v2**：安装模型发现插件，使用 Responses 接口；v1 的 Anthropic SDK 配置保留在[OpenCode 指南](opencode.md#using-with-opencode)中。
- **Codex**：在 `~/.codex/config.toml` 中添加网关配置，见 [Codex 参考配置](codex.md#codex-configtoml-参考配置)。

<a id="running-from-source"></a>

## 从源码运行

<a id="installation"></a>

下载仓库、进入项目目录，再安装依赖：

```sh
git clone https://github.com/caozhiyuan/copilot-api.git
cd copilot-api
bun install
```

> [!NOTE]
> 使用 `tsdown@0.23` 从源码构建时，需要 Node.js `^22.18.0 || ^24.11.0 || >=26.0.0`。这只是构建期要求；已发布 CLI 的运行时要求为 Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`。

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
