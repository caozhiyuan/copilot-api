# AGY CLI

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/agy-cli.md)

在项目目录运行 Antigravity CLI（`agy`）。使用 Google 账号直连时，复杂编码或全仓审查可以在 `/model` 中选择可用的 `Gemini 4 Neon (XHigh)`。[AGY CLI 安装指南](https://antigravity.google/docs/getting-started?tab=cli) · [模型说明](https://antigravity.google/docs/models)

## 接入 copilot-api

启动支持 Gemini REST 接口的 copilot-api，并启用至少一个上游模型服务。在 Desktop 的 **API Keys** 页或通过 CLI 配置一个网关 API Key，替换下方的 `your-gateway-api-key`。[安装与启动](getting-started.md) · [管理网关 API Key](cli.md#管理网关-api-key)

在当前终端设置环境变量，再从同一终端运行 `agy`。`AGY_LLM_GATEWAY_URL` 填网关根地址，`agy` 会自动拼接模型列表和推理路径。`genai` 使用 Gemini 协议。[Google 网关协议说明](https://docs.cloud.google.com/gemini/enterprise/docs/ai-developer-tools/deploy-enterprise-gateway#supported-wire-protocols)

### Windows PowerShell

```powershell
$env:AGY_LLM_GATEWAY_URL = "http://127.0.0.1:4141"
$env:AGY_LLM_GATEWAY_API_KEY = "your-gateway-api-key"
$env:AGY_LLM_GATEWAY_WIRE_PROTOCOL = "genai"

$headers = @{ Authorization = "Bearer $env:AGY_LLM_GATEWAY_API_KEY" }
(Invoke-RestMethod "$env:AGY_LLM_GATEWAY_URL/v1beta/models" -Headers $headers).models |
  Select-Object name, displayName
```

### macOS / Linux

```sh
export AGY_LLM_GATEWAY_URL="http://127.0.0.1:4141"
export AGY_LLM_GATEWAY_API_KEY="your-gateway-api-key"
export AGY_LLM_GATEWAY_WIRE_PROTOCOL="genai"

curl -fsS "$AGY_LLM_GATEWAY_URL/v1beta/models" \
  -H "Authorization: Bearer $AGY_LLM_GATEWAY_API_KEY"
```

### 验证模型请求

用模型列表中 `name` 去掉 `models/` 前缀后的值替换示例里的 `gemini-4-neon`。

```sh
agy --print "只回复 OK" --model gemini-4-neon
```

正常交互时，在项目目录执行 `agy`，再用 `/model` 选择网关提供的模型。

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
