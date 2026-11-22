# AGY CLI

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/agy-cli.md)

Strict AGY model access controls currently prevent copilot-api from proxying these models. Use Antigravity CLI (`agy`) directly from your project directory. For complex coding tasks or full-repository reviews, try `Gemini 4 Neon (XHigh)` when it is available in `/model`. [Install AGY CLI](https://antigravity.google/docs/getting-started?tab=cli) · [Model selection](https://antigravity.google/docs/models)

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
