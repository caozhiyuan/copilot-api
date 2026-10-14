# Troubleshooting

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/troubleshooting.md)

<a id="troubleshooting"></a>

## Troubleshooting

**Claude models missing from the GitHub Copilot model list**

GitHub Copilot can return a different model list depending on the network location the gateway connects from. If your Copilot account has Claude models enabled but `/v1/models` lists no `claude-*` models and requests for them fail (for example with `model_not_supported`), route the gateway's upstream traffic through your proxy and restart it:

```sh
HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 bunx --bun @jeffreycao/copilot-api start --proxy-env
```

Replace the address with your proxy. The gateway caches the model list at startup and refreshes it about every 30 minutes; after the list changes, [regenerate the Codex model catalog](codex.md#generate-model_catalogjson).
