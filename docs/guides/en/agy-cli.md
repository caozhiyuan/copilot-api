# AGY CLI

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/agy-cli.md)

Run Antigravity CLI (`agy`) from your project directory. When signed in directly with a Google Account, try `Gemini 4 Neon (XHigh)` for complex coding tasks or full-repository reviews if it is available in `/model`. [Install AGY CLI](https://antigravity.google/docs/getting-started?tab=cli) · [Model selection](https://antigravity.google/docs/models)

## Connect to copilot-api

Start a version of copilot-api with the Gemini REST endpoints and enable at least one upstream provider. Configure a gateway API key in Desktop's **API Keys** tab or through the CLI, then replace `your-gateway-api-key` below. [Installation and startup](getting-started.md) · [Manage gateway API keys](cli.md#manage-gateway-api-keys)

Set the environment variables and run `agy` in the same terminal. Set `AGY_LLM_GATEWAY_URL` to the gateway base URL. AGY appends the model listing and inference paths. The `genai` setting uses the Gemini protocol. [Google gateway protocol reference](https://docs.cloud.google.com/gemini/enterprise/docs/ai-developer-tools/deploy-enterprise-gateway#supported-wire-protocols)

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

### Test a model request

Use a model's `name` from the list with the `models/` prefix removed. For models with multiple reasoning levels, the list contains IDs such as `gemini-4-neon-high`. AGY also accepts the base ID `gemini-4-neon`.

```sh
agy --print "Reply with OK only." --model gemini-4-neon
```

For an interactive session, run `agy` in your project directory and use `/model` to select a model from the gateway.

The model list follows each provider's `agentsModels` selection. Use original model IDs such as `gpt-6.2-astra` in that setting. An empty list hides the provider's models from AGY.

AGY can attach images and PDFs to models advertised with a `my-gemini-` prefix. For example, use `codex/my-gemini-gpt-6.2-astra` in `agy --model` or in AGY settings. The gateway resolves the alias to the original provider and model.

Use `/effort` to switch reasoning levels when the selected model offers multiple levels. You can set a level at launch with `agy --model gemini-4-neon --effort high` if the gateway lists that model and level.

## Disable telemetry

With a personal Google Account, run `/config` in AGY and set **Enable Telemetry** to `off`. AGY saves this preference to your account. [AGY settings reference](https://antigravity.google/docs/settings?tab=cli)

When telemetry is enabled, Google can use your interactions to improve Antigravity and its models. This data can include code you share in a conversation. [Antigravity terms of service](https://antigravity.google/terms)

## Cross-platform settings

Merge these settings into your existing `~/.gemini/antigravity-cli/settings.json`. On Windows, macOS, and Linux, `~` refers to your user home directory. [AGY settings reference](https://antigravity.google/docs/settings?tab=cli)

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

`code --wait` uses the VS Code `code` command from your `PATH`. When AGY prompts you to trust a folder, confirm the local project directory on each machine. AGY records that path in `trustedWorkspaces`.

This example enables access outside the workspace and adds an allow rule for `git push`. Merge the rule into your existing permissions. If the host lacks terminal sandbox support, `proceed-in-sandbox` falls back to `request-review`. [AGY permissions](https://antigravity.google/docs/permissions/)

## AGY CLI Statusline

The plugin monitors most AGY runtime metrics, including model and agent state, context and token usage, cache hit rates, subagent and Workflow Agent counts, and quota reported by the CLI.

With Node.js 20+ on your `PATH`, install the plugin from your terminal.

```sh
agy plugin install https://github.com/caozhiyuan/copilot-api/tree/dev/plugin/agy/statusline
```

Run `/install-statusline` in AGY, then restart AGY. The installer generates `statusLine.command` for your operating system using the actual plugin installation path. Run it on each machine to register the local plugin. [Statusline installation and metrics](../../../plugin/agy/statusline/README.md)
