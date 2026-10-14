# Installation and Startup

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/getting-started.md)

## Project Overview

A small AI gateway that can use GitHub Copilot, the built-in `codex` provider, or configured third-party providers such as DashScope. GitHub Copilot is optional: if no GitHub token is available, the server can still start in provider-only mode as long as at least one enabled provider is configured.

The gateway exposes OpenAI- and Anthropic-compatible APIs from one local endpoint, so tools like [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), OpenCode, Codex, and OpenAI-compatible clients can share the same local server.

On the GitHub Copilot path, the gateway prefers Copilot's native Anthropic-style Messages API when available, preserving more Claude-native behavior for tool-heavy workflows.

## Important Notes

> [!IMPORTANT]
> **Before using, please be aware of the following:**
>
> 1. **Codex configuration:** When using with Codex, add the gateway provider to `~/.codex/config.toml`. See [Codex `config.toml` Reference](codex.md#codex-configtoml-reference).
>
> 2. **Claude Code configuration:** When using with Claude Code, please configure the model ID as `claude-opus-4-8[1m]`. Example claude `settings.json` see [Manual Configuration with `settings.json`](claude-code.md#manual-configuration-with-settingsjson).
>
> 3. **OpenCode configuration:** When using with OpenCode, configure `~/.config/opencode/opencode.json` with `@ai-sdk/anthropic`. See [Using with OpenCode](opencode.md#using-with-opencode).
>
> 4. **Built-in `copilot`, `codex` and third-party providers:** Run `bunx --bun @jeffreycao/copilot-api auth` and choose `copilot`, `codex`, `deepseek`, `custom`, or other providers.
>
> 5. **Note:** Before using GitHub Copilot, read the [GitHub Copilot Security Notice](../../../NOTICE.md#github-copilot-security-notice).

## Prerequisites

- Bun >= 1.4.0 (recommended)
- Node.js >= 22.13.0 if you plan to run the published CLI with `npx`
- GitHub account with Copilot subscription only if you want to use the GitHub Copilot provider
- An API key or OAuth login for at least one configured provider if you want to run without GitHub Copilot

## Installation

To install dependencies, run:

```sh
bun install
```

## Running from Source

> [!NOTE]
> Building from source with `tsdown@0.23` requires Node.js `^22.18.0 || ^24.11.0 || >=26.0.0`. This is a build-time requirement only; the published CLI supports Node.js >= 22.13.0.

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

<a id="using-with-bun"></a>

## Running the npm package with Bun (recommended)

Install [Bun >= 1.4.0](https://bun.sh/docs/installation), then run the published npm package directly:

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

Omit `@latest` for routine `bunx` starts, or pin an exact package version for repeatable deployments. In repeated `--help` tests with Bun 1.4.0 on Linux, `@latest` re-entered dependency resolution on every invocation; unversioned and exact-version runs reused the warm install without installation output. Re-entering installation does not imply every dependency is downloaded again. Cache expiry and Bun versions can affect this behavior.

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

For authentication or provider configuration only:

```sh
bunx --bun @jeffreycao/copilot-api auth
```

To run without GitHub Copilot, configure at least one provider first, then start the server normally:

```sh
bunx --bun @jeffreycao/copilot-api auth login --provider dashscope
bunx --bun @jeffreycao/copilot-api start
```

## Using with npx

Node.js >= 22.13.0 is supported as an alternative:

```sh
npx @jeffreycao/copilot-api@latest start
```

Token usage storage uses Node's built-in `node:sqlite`, available without `--experimental-sqlite` from Node.js 22.13.0. With Bun, storage uses `bun:sqlite` instead.
