# Copilot API Statusline（Antigravity CLI 插件）

[English](README.md) | 简体中文

这是 [copilot-api](https://github.com/caozhiyuan/copilot-api) 仓库中的独立 `agy` 状态栏插件，数据来自 CLI 提供的状态信息和本地会话日志。

支持 **Windows、macOS、Linux**，要求 Node.js 20+，无需安装 npm 依赖。

## 从 GitHub 安装（推荐）

直接从 `dev` 分支安装插件子目录：

```sh
agy plugin install https://github.com/caozhiyuan/copilot-api/tree/dev/plugin/agy/statusline
agy plugin list
```

### 首次启动直接显示

安装插件后，在打开 AGY 之前从普通终端运行安装脚本。

**Windows PowerShell：**

```powershell
node "$HOME\.gemini\config\plugins\copilot-api-statusline\scripts\install.js"
agy
```

**macOS / Linux：**

```sh
node "$HOME/.gemini/config/plugins/copilot-api-statusline/scripts/install.js"
agy
```

上面的路径是 AGY 默认的全局安装位置。用 `agy plugin list --json` 可以查看实际插件路径。

AGY 新版本支持从 GitHub 仓库**子目录**安装插件。如果你的 AGY 版本无法正确解析 GitHub 子目录地址，请使用下面的本地安装方式。

### 本地安装（备用）

```sh
git clone --branch dev --single-branch https://github.com/caozhiyuan/copilot-api.git
agy plugin validate ./copilot-api/plugin/agy/statusline
agy plugin install ./copilot-api/plugin/agy/statusline
agy plugin list
```

较新的 AGY CLI 还支持直接验证 GitHub 子目录 URL：

```sh
agy plugin validate https://github.com/caozhiyuan/copilot-api/tree/dev/plugin/agy/statusline
```

## 启用方式

在 AGY 中执行 `/install-statusline` 配置状态栏，然后重启 AGY。也可以把保存的 `statusLine.command` 传给内置的 `/statusline <command>`，在当前会话加载。

### 已经配置其他 Statusline？

安装脚本会保留已有的自定义命令和明确禁用的状态栏（`enabled: false`）。如果 `statusLine.command` 是空字符串或只有空白，则会自动配置。

要切换到本插件，先用 `agy plugin list --json` 找到已安装的插件目录，进入该目录后执行以下命令。

```sh
node ./scripts/install.js --force
```

本地开发时，也可以从检出的仓库执行安装脚本。状态栏会使用该仓库内的脚本路径，使用期间请保留该目录。

## 显示效果

```text
🤖 Gemini 4 Argon (Medium)  WORKING  SUB 2 RUN | 5 FOUND | WORKFLOW AGENTS 8
CTX [##------------] 14.2% (149K/1.0M)
IN 2.4M | OUT 161K
CACHE HIT  Last request 96.2% | Session 93.8%
QUOTA gemini-weekly: 94%
```

以上数值只是示例。

| 指标 | 含义 |
| --- | --- |
| `SUB N RUN` | 官方 Statusline JSON 中正在运行的子 Agent 数量 |
| `N FOUND` | 从本地日志和元数据中发现的普通子 Agent 会话数，包含嵌套子 Agent |
| `WORKFLOW AGENTS N` | 从本地任务日志和报告中发现的 Workflow Agent 会话数，按 ID 去重 |
| `CTX` | 主 Agent 的上下文使用率，**不是**自动压缩阈值 |
| `IN / OUT` | 主会话及已发现的普通子 Agent、Workflow Agent 的 Token 累计 |
| `CACHE HIT` · `Last request` | 主 Agent 最近一次请求的缓存命中率 |
| `CACHE HIT` · `Session` | 根据本地日志汇总当前会话、普通子 Agent 和 Workflow Agent 的缓存命中率 |
| `QUOTA` | CLI 原生传入的配额；不单独请求配额 API |

AGY 写出子会话 ID 后，状态栏就能更新计数。Workflow Agent 的会话日志写出用量后，就会计入累计值。用量尚未写出时，累计 Token 显示 `N/A`。

## 隐私与数据来源

- 状态来源：AGY 通过 stdin 传给状态栏的 JSON。
- 累计统计读取本地 `transcript_full.jsonl` / `transcript.jsonl`、子 Agent 关系元数据和任务日志尾部。
- 本地缓存：仅保存数字统计和子会话 ID，避免每次重复解析。
- 不请求 Google 内部接口，不读取凭据，也不连接 copilot-api 网关。

## 管理、更新与卸载

```sh
agy plugin list
agy plugin disable copilot-api-statusline
agy plugin enable copilot-api-statusline
agy plugin uninstall copilot-api-statusline
```

升级时从同一个 GitHub 子目录重新安装，再运行 `/install-statusline` 刷新保存的状态栏命令。也可以从终端运行安装脚本刷新。

**卸载插件不会自动删除用户的 `statusLine` 设置。** 请在 AGY 中执行 `/statusline delete`，或从 `~/.gemini/antigravity-cli/settings.json` 中仅删除 `statusLine` 字段，恢复默认状态栏。

## 可选路径

- `GEMINI_HOME` 用来指定原 `~/.gemini` 目录。安装器在该目录下写入 `antigravity-cli/settings.json`。
- `ANTIGRAVITY_CLI_HOME` 用来指定状态栏读取 `brain/` 日志和写入 `statusline-cache/` 缓存的上级目录。
- `ANTIGRAVITY_BRAIN_DIR`：覆盖会话日志根目录。
- `ANTIGRAVITY_STATUSLINE_CACHE`：覆盖本地数字统计缓存目录。

## 开发与排查

在 copilot-api 仓库根目录执行：

```sh
node --check plugin/agy/statusline/scripts/statusline.js
node --check plugin/agy/statusline/scripts/install.js
node --test plugin/agy/statusline/scripts/statusline.test.js
agy plugin validate ./plugin/agy/statusline
```

- **找不到安装 Skill**。重新安装插件后，在 AGY 中执行 `/skills reload` 或重启 AGY。
- **`Session N/A`**。本地日志可能还未写出，或暂时没有输入用量。可检查日志路径变量。
- **GitHub 安装失败**：升级 AGY，或按上面的本地安装方式安装。
- **完全没有状态栏**：检查 `node`、`agy plugin list --json`、`statusLine` 设置。
- **插件校验失败**：运行 `agy plugin validate ./plugin/agy/statusline`，按报错排查。

Node.js 的模拟数据单元测试已提供，但**尚未完成各系统真实 AGY CLI 安装和真实日志格式验证**。

相关：[AGY 插件文档](https://antigravity.google/docs/plugins?tab=cli) · [官方开发规范](https://antigravity.google/docs/build-plugins/)。
