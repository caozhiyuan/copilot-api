# Copilot API Statusline（Antigravity CLI 插件）

[English](README.md) | 简体中文

这是放在 [copilot-api](https://github.com/caozhiyuan/copilot-api) 仓库中的独立 `agy` 状态栏插件。**不需要 Skill**，不用运行 copilot-api 网关，也不提供 AGY 模型代理；只使用 CLI 提供的 Statusline JSON 和本地会话日志，不读取 OAuth/CSRF，不调用内部 ConnectRPC。

支持 **Windows、macOS、Linux**，要求 Node.js 20+，无需安装 npm 依赖。

## 从 GitHub 安装（推荐）

**PR #541 尚未合并到 `dev` 时**，安装功能分支的插件子目录：

```sh
agy plugin install https://github.com/caozhiyuan/copilot-api/tree/feat/agy-statusline-plugin/plugin/agy/statusline
agy plugin list
```

**合并到 `dev` 后**，使用：

```sh
agy plugin install https://github.com/caozhiyuan/copilot-api/tree/dev/plugin/agy/statusline
```

注意：现在不要提前使用 `dev` 命令。AGY 新版本支持从 GitHub 仓库**子目录**安装插件。如果你的 AGY 版本不能正确解析带斜杠的功能分支名，请使用下面的本地安装方式。

### 本地安装（备用）

```sh
git clone --branch feat/agy-statusline-plugin --single-branch https://github.com/caozhiyuan/copilot-api.git
agy plugin validate ./copilot-api/plugin/agy/statusline
agy plugin install ./copilot-api/plugin/agy/statusline
agy plugin list
```

较新的 AGY CLI 还支持直接验证 GitHub 子目录 URL：

```sh
agy plugin validate https://github.com/caozhiyuan/copilot-api/tree/feat/agy-statusline-plugin/plugin/agy/statusline
```

## 启用方式

1. 安装插件。
2. 重新启动 `agy`（如有必要），开启新的对话。
3. 插件通过 `SessionStart` Hook 自动写入 `~/.gemini/antigravity-cli/settings.json` 的 `statusLine.command`；**只有未配置状态栏时才会写入**。
4. 状态栏显示模型、Context、Token、缓存命中率、子 Agent 数量，以及 AGY 原生配额信息（若有）。

**不需要执行 `/xxx:statusline` 或任何 Skill。**

### 已经配置其他 Statusline？

安装插件不会覆盖已有状态栏。要明确切换到本插件，可在本地克隆的仓库目录外执行：

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
CTX ███░░░░░░░░░░░ 14.2% (149K/1.0M)
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

- **安装成功却没有变化**：重启 AGY、开启新会话；已使用其他自定义状态栏则需要手动 `--force`。
- **`SESSION N/A`**：本地日志尚不存在，或当前 AGY 版本日志结构不同。
- **GitHub 安装失败**：升级 AGY，或按上面的本地安装方式安装。
- **完全没有状态栏**：检查 `node`、`agy plugin list --json`、`statusLine` 设置。
- **插件校验失败**：运行 `agy plugin validate ./plugin/agy/statusline`，按报错排查。

Node.js 的模拟数据单元测试已提供，但**尚未完成各系统真实 AGY CLI 安装和真实日志格式验证**。

相关：[PR #541](https://github.com/caozhiyuan/copilot-api/pull/541) · [AGY 插件文档](https://antigravity.google/docs/plugins?tab=cli) · [官方开发规范](https://antigravity.google/docs/build-plugins/)。
