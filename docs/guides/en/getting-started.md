# Installation and Startup

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/getting-started.md)

## Project Overview

Copilot API connects multiple model providers to one local address. Point Claude Code, OpenCode, Codex, or another compatible client at the gateway to use your configured models.

Sign in to GitHub Copilot, Codex, or xAI, or configure an API key for a provider such as DeepSeek or DashScope. GitHub Copilot is optional; at least one configured and enabled provider is required.

## Prerequisites

- Bun >= 1.4.4 is recommended. Running the published package with Bun does not require a separate Node.js installation.
- Alternatively, use npx with Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`.
- The GitHub Copilot provider requires a Copilot subscription. Other providers require their own API key or account.

See the [home page](../../../README.md#quick-start) for runtime security updates.

## Configure an account or API key

The commands below use Bun. With Node.js only, replace `bunx --bun @jeffreycao/copilot-api` with `npx @jeffreycao/copilot-api@latest`.

On first use, select a provider and follow the sign-in or API key prompts:

```sh
bunx --bun @jeffreycao/copilot-api auth login
```

For example, configure DashScope without GitHub Copilot:

```sh
bunx --bun @jeffreycao/copilot-api auth login --provider dashscope
```

Then start the gateway with Bun or npx below. With the default configuration, a first `start` without an available account or provider also opens provider setup. Before using GitHub Copilot, read the [security notice](../../../NOTICE.md#github-copilot-security-notice).

<a id="using-with-bun"></a>

## Running the npm package with Bun (recommended)

Install [Bun >= 1.4.4](https://bun.sh/docs/installation), then run the published npm package directly:

```sh
bunx --bun @jeffreycao/copilot-api start
```

The `--bun` flag is required: the package has a Node shebang, so plain `bunx` can still launch Node.js. No separate Node.js install is needed to run the published package with Bun.

For frequent use, install globally and explicitly run the installed CLI with Bun:

```sh
bun add --global @jeffreycao/copilot-api
bun run --bun copilot-api start
```

Ensure Bun's global binary directory (`bun pm bin -g`) is on `PATH`. Running plain `copilot-api start` follows the Node shebang; use `bun run --bun` to keep the Bun runtime.

### Cache and upgrades

For routine starts, omit `@latest` to reuse a cached installation, or pin an exact version. Use `@latest` when upgrading. Cache behavior can vary with the Bun version and cache expiry.

Request the latest published version explicitly when upgrading:

```sh
# bunx: resolve the latest version once, then omit @latest for routine starts
bunx --bun @jeffreycao/copilot-api@latest start

# Global installation: update once, then run the installed CLI
bun add --global @jeffreycao/copilot-api@latest
bun run --bun copilot-api start
```

See [Bun's bunx documentation](https://bun.sh/docs/pm/bunx) for runtime selection and caching.

With options:

```sh
bunx --bun @jeffreycao/copilot-api auth keys --add your-gateway-api-key
bunx --bun @jeffreycao/copilot-api start --host 0.0.0.0 --port 8080
```

Binding to `0.0.0.0` exposes the gateway to the network, so the server requires at least one gateway API key and restricts CORS to same-origin requests.

<a id="using-with-npx"></a>

## Using with npx

Node.js `^22.23.4 || ^24.22.1 || >=26.12.1` is supported as an alternative:

```sh
npx @jeffreycao/copilot-api@latest start
```

Token usage storage uses Node's built-in `node:sqlite`, available without `--experimental-sqlite` from Node.js 22.13.0. With Bun, storage uses `bun:sqlite` instead.

<a id="important-notes"></a>

## Check the service and connect a client

After starting the gateway, check its model list:

```sh
curl http://localhost:4141/v1/models
```

If gateway API key authentication is enabled, include an `x-api-key` header. Gateway keys authenticate clients to this local service; upstream provider keys authenticate the gateway to model providers. See [CLI key management](cli.md#auth-command-options).

- **Claude Code**: Configure the gateway address and an available model in `.claude/settings.json`; see [Claude Code setup](claude-code.md#manual-configuration-with-settingsjson). No single model ID is required.
- **OpenCode v2**: Install the model discovery plugin, which uses Responses. The legacy v1 Anthropic SDK setup remains in the [OpenCode guide](opencode.md#using-with-opencode).
- **Codex**: Add the gateway to `~/.codex/config.toml`; see the [Codex reference configuration](codex.md#codex-configtoml-reference).

<a id="running-from-source"></a>

## Running from Source

<a id="installation"></a>

Clone the repository, enter its directory, and install dependencies:

```sh
git clone https://github.com/caozhiyuan/copilot-api.git
cd copilot-api
bun install
```

> [!NOTE]
> Building from source with `tsdown@0.23` requires Node.js `^22.18.0 || ^24.11.0 || >=26.0.0`. This is a build-time requirement only; the published CLI requires Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`.

The project can be run from source in several ways:

### Development Mode

```sh
bun run dev start
```

### Production Mode

```sh
bun run start start
```

> The trailing `start` is the CLI subcommand passed to `src/main.ts`, not a typo: `bun run dev start` runs watch mode, `bun run start start` runs production.
