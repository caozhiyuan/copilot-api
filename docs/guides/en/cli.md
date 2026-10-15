# CLI Reference

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/cli.md)

## Command Structure

Copilot API now uses a subcommand structure with these main commands:

- `start`: Start the gateway server. If a GitHub token is available, the server starts with Copilot enabled. If no GitHub token is available, it starts in provider-only mode when at least one enabled provider exists; otherwise it guides you through provider setup.
- `auth`: Run provider login or configuration without starting the server. Use it for GitHub Copilot login, Codex OAuth, or third-party provider API key setup.
- `debug`: Display diagnostic information including version, runtime details, file paths, and authentication status. Useful for troubleshooting and support.

## Command Line Options

### Global Options

The following options can be used with any subcommand. When passing them before the subcommand, use the `--key=value` form:

| Option            | Description                                            | Default | Alias |
| ----------------- | ------------------------------------------------------ | ------- | ----- |
| --api-home        | Path to the API home directory (sets COPILOT_API_HOME) | none    | none  |
| --oauth-app       | OAuth app identifier (sets COPILOT_API_OAUTH_APP)      | none    | none  |
| --enterprise-url  | Enterprise URL for GitHub (sets COPILOT_API_ENTERPRISE_URL) | none | none |

### Start Command Options

The following command line options are available for the `start` command:

| Option         | Description                                                                   | Default    | Alias |
| -------------- | ----------------------------------------------------------------------------- | ---------- | ----- |
| --host         | Host to listen on; non-loopback hosts require a configured gateway API key   | 127.0.0.1 | none  |
| --port         | Port to listen on                                                             | 4141       | -p    |
| --verbose      | Enable verbose logging                                                        | false      | -v    |
| --github-token | Provide GitHub token directly (must be generated using the `auth` subcommand); prefer `COPILOT_API_GITHUB_TOKEN`, since arguments are visible in the process list | none       | -g    |
| --show-token   | Show GitHub and Copilot tokens on fetch and refresh                           | false      | none  |
| --proxy-env    | Initialize proxy from environment variables                                   | false      | none  |

Passing the GitHub token on the command line exposes it to every local user through the process list, so prefer the `COPILOT_API_GITHUB_TOKEN` environment variable. The gateway resolves the token in this order: `--github-token` → `COPILOT_API_GITHUB_TOKEN` → the token file written by `auth login`.

### Auth Command Options

| Option       | Description               | Default | Alias |
| ------------ | ------------------------- | ------- | ----- |
| --provider   | Provider to log in with or configure (`copilot`, `codex`, `opencode-go`, `kimi`, `deepseek`, `dashscope`, `openrouter`, or `custom`) | prompt | none |
| --alias      | Optional Codex account alias; only valid with `--provider codex` | none | none |
| --verbose    | Enable verbose logging    | false   | -v    |
| --show-token | Show GitHub token on auth | false   | none  |

Use `copilot-api auth login --provider copilot` only when you want to enable the GitHub Copilot provider. Copilot is not required for `codex` or third-party provider-only usage.

The Codex provider stores up to 3 accounts. Add or update an account with `copilot-api auth login --provider codex --alias work`; the newly signed-in account becomes active. List accounts with `copilot-api auth codex --list`, switch with `copilot-api auth codex --use <alias-or-accountId>`, and remove an account that is not in use with `copilot-api auth codex --remove <alias-or-accountId>`. Aliases are case-insensitive and cannot duplicate another account's alias or ID; the account currently in use cannot be removed. Restart a running server after switching or removing an account so it stops using the previous account; a credential refresh never writes a removed account back. Legacy single-account `codex_credentials.json` files remain compatible and upgrade to the multi-account shape on the next credential write.

Use `copilot-api auth login --provider deepseek`, `--provider dashscope`, `--provider openrouter`, `--provider opencode-go`, or `--provider kimi` to add or update those common third-party providers from the CLI. DeepSeek prompts for masked `apiKey`, provider `type` (default `anthropic`), and `baseUrl` defaulting to `https://api.deepseek.com/anthropic`. DashScope prompts for masked `apiKey`, provider `type` (default `openai-compatible`), and prefilled `baseUrl`. OpenRouter prompts for masked `apiKey` and prefilled `baseUrl` only, and writes `type: "anthropic"`. OpenCode Go prompts for masked `apiKey` and prefilled `baseUrl` only, and writes `type: "openai-compatible"` (baseUrl `https://opencode.ai/zen/go`). Kimi prompts for masked `apiKey`, provider `type` (default `openai-compatible`), and `baseUrl` defaulting to `https://api.kimi.com/coding` (the same base URL serves both the Anthropic and OpenAI-compatible endpoints). OpenCode Go selects the protocol from the model-level models.dev `provider.npm`, then the provider-level `npm`: `@ai-sdk/anthropic` uses Anthropic Messages, `@ai-sdk/openai` uses OpenAI Responses (unless the model has `shape: completions`), and unrecognized or missing packages use OpenAI-compatible. After a provider is configured and enabled, `copilot-api start` can run without any GitHub token.

OpenCode Go model listings (`/opencode-go/v1/models` and its entries in `/v1/models`) use the `opencode-go.models` section of [models.dev/api.json](https://models.dev/api.json). At startup the server loads `models-dev-api.json` from `COPILOT_API_HOME` (or the default app data directory). If a valid cache exists, the server starts listening and refreshes the catalog in the background every five minutes. Without a valid cache, startup waits for the first download and fails if it cannot obtain a catalog. Refreshes use `ETag` or `Last-Modified` when available; both validators are saved in `models-dev-api.meta.json` with a checksum of the JSON. A `304` keeps the existing cache, and a failed background refresh keeps the last valid disk or memory catalog. Models marked `status: deprecated` are excluded.

Use `copilot-api auth login --provider custom` to add or update another third-party provider from the CLI. Choose manual entry or search the existing models.dev catalog. The catalog selection includes providers with an HTTP API URL using Anthropic Messages, OpenAI-compatible Chat Completions, OpenAI Responses, or Google Gemini; `openrouter`, `github-copilot`, and `opencode-go` are excluded. The selected provider ID, protocol, and API URL prefill editable fields, and models.dev model prices are used for token cost estimates in USD unless a model has explicit pricing in `config.json`. The command then prompts for masked `apiKey` and `authType`; `authType` may be left as the type default or set to `x-api-key` / `x-goog-api-key` / `authorization`. The desktop custom-provider form offers the same catalog selection and manual entry.

Gateway API keys live under `auth.apiKeys` in `config.json`. Manage them with `copilot-api auth keys` (one operation per invocation): add a key with `--add <key>`, remove one with `--remove <key>`, list all with `--list`, or clear them all with `--clear`. Clients authenticate with any configured key via `x-api-key` or `Authorization: Bearer`. Without keys, loopback listeners start with authentication bypassed and print an info message; non-loopback listeners refuse to start.

### Debug Command Options

| Option | Description               | Default | Alias |
| ------ | ------------------------- | ------- | ----- |
| --json | Output debug info as JSON | false   | none  |

## Example Usage

Common commands for the npm package (Bun >= 1.4.0 recommended):

```sh
# Start the gateway
bunx --bun @jeffreycao/copilot-api start

# Start on a custom port with verbose logging
bunx --bun @jeffreycao/copilot-api start --port 8080 --verbose

# Run the auth flow
bunx --bun @jeffreycao/copilot-api auth login

# Configure a third-party provider, then run without GitHub Copilot
bunx --bun @jeffreycao/copilot-api auth login --provider dashscope
bunx --bun @jeffreycao/copilot-api start

# Print debug information as JSON
bunx --bun @jeffreycao/copilot-api debug --json

# Or install globally, then force the installed CLI to use Bun
bun add --global @jeffreycao/copilot-api
bun run --bun copilot-api start
```

OpenAI-compatible provider examples after configuring `dashscope`:

```sh
curl http://localhost:4141/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"dashscope/qwen3.6-plus","messages":[{"role":"user","content":"hello"}]}'

curl http://localhost:4141/dashscope/v1/messages \
  -H "content-type: application/json" \
  -d '{"model":"qwen3.6-plus","max_tokens":1024,"messages":[{"role":"user","content":"hello"}]}'
```

For cache behavior, upgrades, and the Node.js alternative, see [Installation and Startup](getting-started.md#using-with-bun).
