# Copilot API Statusline（Antigravity CLI 插件）

[English](README.md) | 简体中文

这是放在 [copilot-api](https://github.com/caozhiyuan/copilot-api) 仓库中的独立 `agy` 状态栏插件。**不需要 Skill**，不用运行 copilot-api 网关，也不提供 AGY 模型代理；只使用 CLI 提供的 Statusline JSON 和本地会话日志，不读取 OAuth/CSRF，不调用内部 ConnectRPC。

支持 **Windows、macOS、Linux**，要求 Node.js 20+，无需安装 npm 依赖。

## 从 GitHub 安装（推荐）

直接从 `dev` 分支安装插件子目录：

```sh
agy plugin install https://github.com/caozhiyuan/copilot-api/tree/dev/plugin/agy/statusline
agy plugin list
```

### 首次启动直接显示（推荐）

`agy plugin install` 只安装插件文件；`SessionStart` 要等新会话开始才执行。**如果只安装插件就立刻打开 AGY，第一次进入时状态栏可能还未激活，需要发一条消息让 Hook 写入设置，再重启才显示。**

为了避免“先输入 hi，再重启”的步骤，请在**普通终端（不要在 AGY 内）**安装插件后、**首次运行 `agy` 前**，额外运行一次安装脚本：

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

脚本只在尚未设置有效状态栏命令时写入 `~/.gemini/antigravity-cli/settings.json`；如果已有其他非空自定义命令，则会显示 `skipped-existing` 并保留原配置。确实想覆盖时，可在安装脚本末尾加 `--force`。上述插件路径是 AGY 默认的全局插件安装位置；其他安装位置可通过 `agy plugin list --json` 查找。

如果 AGY **已经打开**，仅修改磁盘上的 `settings.json` 不一定会让当前界面立即启用状态栏。你可以重启 AGY；或者把已配置的 `statusLine.command` 作为参数输入 AGY 内置的 `/statusline <command>`，AGY 会立即加载状态栏。

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

**推荐流程：** 安装插件后、打开 AGY 前执行上面的 `install.js`，首次启动就可以使用自定义状态栏，不需要先输入 `hi`。

**备选自动配置：** 如果跳过手动安装脚本，插件的 `SessionStart` Hook 会在创建第一条新对话时尝试写入 `statusLine.command`。但本次 AGY 进程可能已经完成了状态栏初始化，因此需要重新启动 AGY，或用内置的 `/statusline <command>` 立即重新配置。

状态栏显示模型、Context、Token、缓存命中率、子 Agent 数量以及 CLI 原生配额（若有）。整个插件**不需要 Skill**，也不需要启动 copilot-api 网关。

### 已经配置其他 Statusline？

安装插件不会覆盖已有**非空命令**的状态栏；若 `statusLine.command` 是空字符串或只有空格（例如 `{ "type": "", "command": "", "enabled": true }`），会自动完成配置。明确设置 `enabled: false` 的状态栏不会被自动启用。要明确切换到本插件，可在本地克隆的仓库目录外执行：

```sh
node ./copilot-api/plugin/agy/statusline/scripts/install.js --force
```

也可以在已安装插件目录中运行 `scripts/install.js --force`。通过下面的命令查看实际安装路径：

```sh
agy plugin list --json
```

Windows 路径含空格时，给 JS 文件的绝对路径加双引号。安装脚本保留其他设置，只修改 `statusLine`；`--force` 仅在你确实要替换旧状态栏时使用。

## 显示效果

```text
🤖 Gemini 4 Argon (Medium)  WORKING  SUB 2 RUN | 5 FOUND
CTX [##------------] 14.2% (149K/1.0M)
IN 2.4M | OUT 161K | LAST 96.2% | SESSION 93.8%
QUOTA gemini-weekly: 94%
```

以上数值只是示例。

| 指标 | 含义 |
| --- | --- |
| `SUB N RUN` | 官方 Statusline JSON 中正在运行的子 Agent 数量 |
| `N FOUND` | 从本地日志和父子元数据中发现的子 Agent 会话 ID 数量，包含嵌套子 Agent |
| `CTX` | 主 Agent 的上下文使用率，**不是**自动压缩阈值 |
| `IN / OUT` | 主 Agent 及可发现子 Agent 的日志 Token 累计 |
| `LAST` | 主 Agent 最近一次请求的缓存命中率 |
| `SESSION` | 当前会话及嵌套子 Agent 的累计缓存命中率（根据本地日志估算） |
| `QUOTA` | CLI 原生传入的配额；不单独请求配额 API |

`SESSION`、`FOUND` 依赖当前 AGY 版本实际写出的会话文件。日志缺失或延迟时，累计结果可能不完整；找不到日志会显示 `N/A`，不会用假数据替代。已发现的子 Agent 不代表它一定有可计入的 Token 数据。

## 隐私与数据来源

- 状态来源：AGY 通过 stdin 传给状态栏的 JSON。
- 累计统计：仅读取本地 `transcript_full.jsonl` / `transcript.jsonl` 和子 Agent 关系元数据。
- 本地缓存：仅保存数字统计和子会话 ID，避免每次重复解析。
- 不请求 Google 内部接口，不读取凭据，也不连接 copilot-api 网关。

## 管理、更新与卸载

```sh
agy plugin list
agy plugin disable copilot-api-statusline
agy plugin enable copilot-api-statusline
agy plugin uninstall copilot-api-statusline
```

升级时使用相同的 GitHub 子目录安装地址重新安装。如果升级后状态栏仍指向旧安装路径，可在新插件目录执行一次 `node scripts/install.js --force`。

**卸载插件不会自动删除用户的 `statusLine` 设置。** 请在 AGY 中执行 `/statusline delete`，或从 `~/.gemini/antigravity-cli/settings.json` 中仅删除 `statusLine` 字段，恢复默认状态栏。

## 可选路径

- `GEMINI_HOME`：覆盖默认的 `~/.gemini` 目录。
- `ANTIGRAVITY_CLI_HOME`：覆盖 CLI 数据目录。
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

- **安装成功却没有变化**：升级或重新安装 v1.0.1，重启 AGY 并**开启新会话**，在 AGY 中执行 `/hooks` 检查 `statusline-setup` 的 `SessionStart` Hook 是否加载。空 `statusLine.command` 现在会自动配置；若原来有其他非空命令，仍需明确执行 `--force` 才会覆盖。
- **`SESSION N/A`**：本地日志尚不存在，或当前 AGY 版本日志结构不同。
- **GitHub 安装失败**：升级 AGY，或按上面的本地安装方式安装。
- **完全没有状态栏**：检查 `node`、`agy plugin list --json`、`statusLine` 设置。
- **插件校验失败**：运行 `agy plugin validate ./plugin/agy/statusline`，按报错排查。

Node.js 的模拟数据单元测试已提供，但**尚未完成各系统真实 AGY CLI 安装和真实日志格式验证**。

相关：[AGY 插件文档](https://antigravity.google/docs/plugins?tab=cli) · [官方开发规范](https://antigravity.google/docs/build-plugins/)。
