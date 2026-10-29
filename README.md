# Copilot API

<p align="center">
  <img src="docs/hero/copilot-api-hero.svg" alt="Copilot API - Universal AI Gateway" width="1600" />
</p>

<p align="center">
  <strong>Universal AI Gateway</strong><br />
  One Gateway. Any Client. Multiple AI Providers.<br />
  Chat Completions &middot; OpenAI Responses &middot; Anthropic Messages
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jeffreycao/copilot-api"><img src="https://img.shields.io/npm/v/@jeffreycao/copilot-api.svg" alt="npm version"></a>
  <a href="https://github.com/caozhiyuan/copilot-api/blob/dev/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/caozhiyuan/copilot-api/stargazers"><img src="https://img.shields.io/github/stars/caozhiyuan/copilot-api.svg" alt="GitHub stars"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-%3E%3D1.4.4-orange.svg" alt="Bun >= 1.4.4"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node-22%20%7C%2024%20%7C%2026-green.svg" alt="Node.js 22, 24, or 26 with security updates"></a>
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

Copilot API is a local AI gateway that connects Claude Code, OpenCode, Codex, and other clients to GitHub Copilot, the built-in Codex and xAI providers, and third-party model providers through a unified API.

## Highlights

- **Unified API Gateway**: Serve OpenAI-compatible Chat Completions (`/v1/chat/completions`), the OpenAI Responses API (`/v1/responses`), and Anthropic-compatible Messages (`/v1/messages`) from one local endpoint.
- **Multi-Provider**: Route GitHub Copilot, the built-in `codex` and `xai` providers, and third-party providers (Kimi, DeepSeek, DashScope, OpenRouter, OpenCode Go, Google Gemini, or a custom provider from models.dev) behind the same gateway. GitHub Copilot is optional — with at least one enabled provider, the server starts in provider-only mode without a GitHub token.
- **Coding Agent Ready**: First-class setups for Claude Code, OpenCode, and Codex, including settings.json gateway model discovery and a merged model catalog for Codex.
- **Streaming & WebSocket**: SSE streaming on all three client-facing protocols. Upstream Copilot Responses traffic selects WebSocket or HTTP from each model's advertised endpoints; streamed Responses traffic for the built-in `codex` provider uses WebSocket by default and uses HTTP when `useResponsesApiWebSocket` is disabled.
- **Desktop App**: Electron GUI with GitHub Copilot sign-in, Codex and xAI OAuth, provider configuration, token usage, logs, and one-click start/stop.

## Quick Start

Use **Node.js 22.x, 24.x, or 26.x with the security updates below** (npx) or **Bun >= 1.4.4**. A Copilot subscription is needed only for the GitHub Copilot provider; other configured providers can run independently.

> [!WARNING]
> **CVE-2026-111497:** The Brotli decoder in affected Node.js and Bun runtimes can corrupt memory and allow remote code execution. Upgrade Node.js 22.x to **22.23.4 or later**, 24.x to **24.22.1 or later**, or 26.x to **26.12.1 or later**; upgrade Bun to **1.4.4 or later**. Restart the gateway after upgrading. For Docker deployments, rebuild and redeploy the image with a patched runtime. See the [Node.js security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) and [Bun security advisory](https://github.com/oven-sh/bun/security/advisories/GHSA-663w-cv8g-jj2p).

```sh
npx @jeffreycao/copilot-api@latest start
```

The server listens on `http://localhost:4141` by default. Optionally authenticate with GitHub Copilot or configure a third-party provider first:

```sh
npx @jeffreycao/copilot-api@latest auth login
```

Alternatively, run with Bun >= 1.4.4, which can offer better performance:

```sh
bunx --bun @jeffreycao/copilot-api start
```

Use `--bun` to select the Bun runtime and omit `@latest` for routine starts to reuse the cache. See [Bun setup](docs/guides/en/getting-started.md#using-with-bun) for global installation and upgrades.

> [!NOTE]
> To trust system-installed CA certificates (for example, behind a corporate HTTPS proxy), `npx` needs no extra configuration: Node.js >= 22.19.0 merges the system CA store at startup through [`tls.setDefaultCACertificates()`](https://nodejs.org/api/tls.html#tlssetdefaultcacertificatescerts). Only Bun requires `NODE_USE_SYSTEM_CA=1` before `bunx --bun`: `export NODE_USE_SYSTEM_CA=1` in bash/zsh, or `$env:NODE_USE_SYSTEM_CA="1"` in PowerShell (Bun >= 1.4.4).
> Desktop enables the variable for server subprocesses by default, preserving explicit environment settings.

Verify the gateway is up:

```sh
curl http://localhost:4141/v1/models
```

> [!NOTE]
> Token usage storage requires Node.js >= 22.13.0 or Bun. See [Using with npx](docs/guides/en/getting-started.md#using-with-npx) for details.

From here, jump to the guide for your client: [Claude Code](docs/guides/en/claude-code.md#using-with-claude-code), [OpenCode](docs/guides/en/opencode.md#using-with-opencode), [Codex](docs/guides/en/codex.md#using-with-codex), [DeepSeek Harness](docs/guides/en/dsh.md#using-with-deepseek-harness), or run it with [Docker](docs/guides/en/docker.md#using-with-docker).

## Compatibility

Every client talks to the same local endpoint. The gateway routes each request to GitHub Copilot, the built-in `codex` or `xai` provider, or a configured third-party provider, translating between protocols when the provider speaks a different one.

**Client / Protocol Matrix**

| Client | Chat Completions | Responses | Anthropic Messages | Recommended |
|---|:---:|:---:|:---:|---|
| Claude Code | — | — | ✅ Native / Adapter | Anthropic Messages |
| OpenCode | ✅ Native | ✅ Native / Adapter | ✅ Native / Adapter | Anthropic Messages |
| Codex | — | ✅ Native / Adapter | — | Responses |
| DeepSeek Harness | — | ✅ Native / Adapter | ✅ Native / Adapter | Responses |
| OpenAI-compatible clients | ✅ Native | ✅ Native / Adapter | — | Chat Completions |
| Anthropic-compatible clients | — | — | ✅ Native / Adapter | Anthropic Messages |

**Providers and protocols.** Protocol support is model-specific. Chat Completions requires a native endpoint, while Responses and Messages can use supported adapters. The built-in `codex` provider uses Responses natively; third-party providers can use `anthropic`, `openai-compatible`, or `openai-responses`, with per-model overrides.

## Desktop App

Prefer a GUI? The Electron desktop app in `desktop/` covers GitHub Copilot sign-in, OpenAI Codex and xAI OAuth, and API-key configuration for Kimi, DeepSeek, DashScope, OpenRouter, or a custom provider from models.dev — with one-click start/stop of the local server, and the local endpoint, auth header, available models, usage, and logs in one window.

<p align="center">
  <img src="docs/screenshots/desktop-dashboard.png" alt="Copilot API desktop app dashboard" width="49%" />
  <img src="docs/screenshots/desktop-token-usage.png" alt="Copilot API desktop app token usage view" width="49%" />
</p>

Windows x64 (`.exe`), macOS Apple Silicon (`.dmg`), and Linux x64 (`.AppImage`) packages are published in [GitHub Releases](https://github.com/caozhiyuan/copilot-api/releases). See [Electron Desktop App](docs/guides/en/desktop.md#electron-desktop-app) for full setup and advanced configuration.

After the initial full-package installation, subsequent updates normally use differential downloads to reduce download size. On macOS, the first update may still download a complete DMG to establish the cache. If the cache is unavailable or differential downloading fails, the app falls back to a full download.

## Documentation

| Guide | Contents |
| --- | --- |
| [Installation and Startup](docs/guides/en/getting-started.md) | Prerequisites, project overview, `npx` and source runs, provider-only mode without Copilot, and gateway API key setup |
| [Claude Code](docs/guides/en/claude-code.md) | settings.json, gateway model discovery, model mappings, auto-compact window, and WebSearch behavior |
| [OpenCode](docs/guides/en/opencode.md) | v2 Responses plugin and automatic model discovery, native compaction, model capabilities and pricing, context limits, and v1 Anthropic SDK setup |
| [Codex](docs/guides/en/codex.md) | A full `config.toml` provider block, `GITHUB_COPILOT_API_KEY` environment variable setup, auto-review model mapping, generating `model_catalog.json`, and the merged model picker catalog with protocol adapters |
| [DeepSeek Harness](docs/guides/en/dsh.md) | Install `dsh-copilot-api`, save the gateway API key, and choose Responses or Messages |
| [Docker](docs/guides/en/docker.md) | Docker Compose quick start, the `/data` persistent mount and its ownership repair, supported environment variables, and host interface binding |
| [Desktop App](docs/guides/en/desktop.md) | Copilot sign-in, Codex OAuth account switching, API-key providers, one-click start / stop, shared model mappings, advanced settings, and per-platform installers |
| [Plugins and Tool Search](docs/guides/en/integrations.md) | The Responses `tool_search` MCP bridge (not needed on opencode v2, which already defers tools through Code Mode), Claude Code `agent-inject` and `tool-search` marketplace plugins, and the opencode subagent marker plugin |
| [Usage Monitoring](docs/guides/en/usage.md) | The usage viewer URL and query parameters, period selectors, Copilot quota progress, token and cost metric cards, trend charts, and paginated request events |
| [CLI Reference](docs/guides/en/cli.md) | Command structure, global options, and the full option sets for the `start`, `auth`, and `debug` subcommands with example usage |
| [Configuration Reference](docs/guides/en/configuration.md) | Every `config.json` field: gateway and admin API keys, provider definitions, model mappings, WebSocket and HTTP transport, timeouts, and context management |
| [API and Authentication](docs/guides/en/api.md) | Allowed auth headers and CORS rules, OpenAI, Codex backend, and Anthropic endpoints, usage monitoring routes, and admin configuration endpoints |
| [Troubleshooting](docs/guides/en/troubleshooting.md) | Fixes for Claude models missing from the Copilot model list |

Before using GitHub Copilot, read the [GitHub Copilot Security Notice](NOTICE.md#github-copilot-security-notice).
