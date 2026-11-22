# AGY CLI

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/agy-cli.md)

AGY 对模型访问的管控较严，copilot-api 目前无法代理 AGY 模型。推荐在项目目录直接运行 Antigravity CLI（`agy`）。复杂编码或全仓审查可以优先试 `Gemini 4 Neon (XHigh)`，模型可用时在 `/model` 中选择。见 [AGY CLI 安装指南](https://antigravity.google/docs/getting-started?tab=cli)和[模型说明](https://antigravity.google/docs/models)。

## 关闭遥测

使用个人 Google 账号时，在 AGY 中运行 `/config`，将 **Enable Telemetry** 设为 `off`。这项设置保存在账号中。见 [AGY 配置说明](https://antigravity.google/docs/settings?tab=cli)。

开启遥测后，Google 可以将会话交互用于改进 Antigravity 和相关模型。你在会话中提供的代码也可能包含在这些数据中。见 [Antigravity 服务条款](https://antigravity.google/terms)。

## 跨平台参考配置

把下面的配置项合并到现有的 `~/.gemini/antigravity-cli/settings.json`。Windows、macOS 和 Linux 上的 `~` 都指当前用户的主目录。见 [AGY 配置说明](https://antigravity.google/docs/settings?tab=cli)。

```json
{
  "allowNonWorkspaceAccess": true,
  "altScreenMode": "always",
  "artifactReviewPolicy": "agent-decides",
  "editor": "code --wait",
  "enableTerminalSandbox": true,
  "model": "Gemini 4 Neon (XHigh)",
  "permissions": {
    "allow": [
      "command(git push)"
    ]
  },
  "showThinking": true,
  "toolPermission": "proceed-in-sandbox"
}
```

`code --wait` 使用 `PATH` 中的 VS Code `code` 命令。AGY 提示是否信任当前目录时，在各台机器上确认实际项目目录，AGY 会把路径写入 `trustedWorkspaces`。

示例允许访问工作区外的文件，并为 `git push` 添加放行规则。把这条规则合并到已有的权限配置中。系统不支持终端沙箱时，`proceed-in-sandbox` 会回退到 `request-review`。见 [AGY 权限说明](https://antigravity.google/docs/permissions/)。

## AGY CLI Statusline

插件可以监控大部分 AGY 运行指标，包括模型和 Agent 状态、上下文与 Token 用量、缓存命中率、子 Agent 和 Workflow Agent 数量，以及 CLI 提供的额度。

确保终端可以运行 Node.js 20 或更新版本，然后安装插件。

```sh
agy plugin install https://github.com/caozhiyuan/copilot-api/tree/dev/plugin/agy/statusline
```

在 AGY 内运行 `/install-statusline`，然后重启 AGY。安装器会根据本机系统和插件的实际安装路径生成 `statusLine.command`。在每台机器上运行安装器即可注册本机插件。见[状态栏安装说明和指标详情](../../../plugin/agy/statusline/README.zh-CN.md)。
