# Troubleshooting

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/troubleshooting.md)

<a id="troubleshooting"></a>

## Troubleshooting

### Claude models missing from the Copilot model list

GitHub Copilot can return a different model list depending on the network location the gateway connects from. If your Copilot account has Claude models enabled but `/v1/models` lists no `claude-*` models and requests for them fail (for example with `model_not_supported`), route the gateway's upstream traffic through your proxy and restart it:

```sh
HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 npx @jeffreycao/copilot-api@latest start --proxy-env
```

In Windows PowerShell, use:

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:HTTP_PROXY = "http://127.0.0.1:7890"
npx @jeffreycao/copilot-api@latest start --proxy-env
```

Replace the address with your proxy. Copilot models load at startup and refresh about every 30 minutes. Reload a remote Codex catalog after changes; [regenerate the catalog file](codex.md#generate-model_catalogjson) only if you use local `model_catalog_json`.

### Client returns 401 or authentication fails

Check the client key first. If the gateway has `auth.apiKeys` configured, use one of those gateway keys instead of `dummy` or an upstream provider key. `/admin/*` endpoints require the separate `auth.adminApiKey`.

### A configured model is absent from the client picker

Check that its provider is enabled and that **Models shown in Coding Agent** (`agentsModels`) allows the model. An empty array hides all models from that provider. Codex, Claude Code, and DeepSeek exclude image-only models; OpenCode can display them. Ordinary and client-specific catalogs apply different filters; see [model discovery](api.md#model-discovery-sources).

### WebSocket requests fail through a proxy

If the model supports HTTP Responses, set `useResponsesApiWebSocket` to `false` in `config.json` and apply the configuration to use HTTP. WebSocket-only models require a proxy or network that permits WebSocket traffic. The gateway does not automatically retry failed WebSocket requests over HTTP. See [connection settings](configuration.md#protocols-reasoning-and-connections).
