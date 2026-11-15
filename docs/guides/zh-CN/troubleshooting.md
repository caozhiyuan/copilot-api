# 故障排查

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/troubleshooting.md)

<a id="troubleshooting"></a>

## 故障排查

### Copilot 模型列表中没有 Claude 模型

GitHub Copilot 返回的模型列表可能因网关所在的网络位置而不同。如果 Copilot 账号已启用 Claude 模型，但 `/v1/models` 中没有任何 `claude-*` 模型，且请求这些模型失败（例如返回 `model_not_supported`），请让网关通过代理访问上游并重启：

```sh
HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 npx @jeffreycao/copilot-api@latest start --proxy-env
```

Windows PowerShell 请使用以下写法：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:HTTP_PROXY = "http://127.0.0.1:7890"
npx @jeffreycao/copilot-api@latest start --proxy-env
```

请替换成你的代理地址。网关在启动时加载 Copilot 模型列表，之后约每 30 分钟刷新。使用 Codex 远程模型目录时，重新加载目录即可；只有配置了本地 `model_catalog_json` 时，才需要重新[生成目录文件](codex.md#一键生成-model_catalogjson)。

### 客户端提示 401 或认证失败

先检查客户端填写的密钥：如果网关配置了 `auth.apiKeys`，应填写其中一个网关 API Key，不能继续使用 `dummy`，也不能用模型服务的 API Key 替代。`/admin/*` 接口则需要单独的 `auth.adminApiKey`。

### 已配置的模型没有出现在客户端列表中

检查该 provider 是否启用，以及“Coding Agent 展示模型”（`agentsModels`）是否包含目标模型。空数组会隐藏该服务的模型。Codex、Claude Code 和 DeepSeek 不显示仅输出图片的模型；OpenCode 可以显示。普通模型列表与客户端专用列表的筛选规则不同，见[模型发现说明](api.md#模型发现来源)。

### 使用代理后 WebSocket 请求仍失败

如果目标模型支持 HTTP Responses 接口，可将 `config.json` 中的 `useResponsesApiWebSocket` 设为 `false`，应用配置后改走 HTTP。如果模型只支持 WebSocket，需要换用允许 WebSocket 的代理或网络；网关不会在 WebSocket 失败后自动改用 HTTP 重试。详见[连接设置](configuration.md#协议推理与连接)。
