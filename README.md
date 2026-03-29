# Copilot API Proxy

English | [中文](./README_CN.md)

> [!WARNING]
> This is a reverse-engineered proxy of GitHub Copilot API. It is not supported by GitHub, and may break unexpectedly. Use at your own risk.

> [!WARNING]
> **GitHub Security Notice:**  
> Excessive automated or scripted use of Copilot (including rapid or bulk requests, such as via automated tools) may trigger GitHub's abuse-detection systems.  
> You may receive a warning from GitHub Security, and further anomalous activity could result in temporary suspension of your Copilot access.
>
> GitHub prohibits use of their servers for excessive automated bulk activity or any activity that places undue burden on their infrastructure.
>
> Please review:
>
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
>
> Use this proxy responsibly to avoid account restrictions.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/E1E519XS7W)

---

> [!NOTE]
> [opencode](https://github.com/sst/opencode) already ships with a built-in GitHub Copilot provider, so you may not need this project for basic usage. This proxy is still useful if you want OpenCode to talk to Copilot through `@ai-sdk/anthropic`, preserve Anthropic Messages semantics for tool use, prefer the native Messages API over Chat Completions API for Claude-family models, use gpt phase-aware commentary, or optimize premium requests.

---
## Important Notes

> [!IMPORTANT]
> **Before using, please be aware of the following:**
>
> 1. **Claude Code configuration:** When using with Claude Code, please configure the model ID as `claude-opus-4-6` or `claude-opus-4.6` (without the `[1m]` suffix, exceeding GitHub Copilot's context window limit too much may lead to being banned). If you prefer editing config manually, see [Manual Configuration with `settings.json`](#manual-configuration-with-settingsjson). Please do not enable `ENABLE_TOOL_SEARCH`, as the current Claude Code uses the client tool search mode. In this mode, loading defer tools requires an additional request each time, and cache hit rates are affected, so it does not necessarily save tokens. Only server tool search mode can save tokens. The current project has compatibility issues with client tool search mode, which can also cause errors when used.
>
> 2. **Recommend for Opencode:** When using with opencode, we recommend starting with the opencode OAuth app. This approach behaves identically to opencode's built-in GitHub Copilot provider with no Terms of Service risk:
>    ```sh
>    npx @nick3/copilot-api@latest --oauth-app=opencode start
>    ```
>
> 3. **Disable multi agent when using codex:** If you're using codex via GitHub Copilot, it's recommended to disable the multi agent feature. Currently, GitHub Copilot charges based on the last message being a user role when using codex, and the billing logic has not been adjusted.

---

## Project Overview

A reverse-engineered proxy for the GitHub Copilot API that exposes it as an OpenAI and Anthropic compatible service. This allows you to use GitHub Copilot with any tool that supports the OpenAI Chat Completions API or the Anthropic Messages API, including to power [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

Compared with routing everything through plain Chat Completions compatibility, this proxy can prefer Copilot's native Anthropic-style Messages API for Claude-family models, preserve more native thinking/tool semantics, reduce unnecessary Premium request consumption on warmup or resumed tool turns, and expose phase-aware `gpt-5.4` / `gpt-5.3-codex` responses that are easier for users to follow.

## Features

- **OpenAI & Anthropic Compatibility**: Exposes GitHub Copilot as an OpenAI-compatible (`/v1/responses`, `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) and Anthropic-compatible (`/v1/messages`) API.
- **Anthropic-First Routing for Claude Models**: When a model supports Copilot's native `/v1/messages` endpoint, the proxy prefers it over `/responses` or `/chat/completions`, preserving Anthropic-style `tool_use` / `tool_result` flows and more Claude-native behavior.
- **Fewer Unnecessary Premium Requests**: Reduces wasted premium usage by routing warmup requests to `smallModel`, merging `tool_result` follow-ups back into the tool flow, and treating resumed tool turns as continuation traffic instead of fresh premium interactions.
- **Phase-Aware `gpt-5.4` and `gpt-5.3-codex`**: These models can emit user-friendly commentary before deeper reasoning or tool use, so long-running coding actions are easier to understand instead of appearing as a sudden tool burst.
- **Claude Native Beta Support**: On the Messages API path, supports Anthropic-native capabilities such as `interleaved-thinking`, `advanced-tool-use`, and `context-management`, which are difficult or unavailable through plain Chat Completions compatibility.
- **Subagent Marker Integration**: Claude Code and opencode plugins can inject `__SUBAGENT_MARKER__...` and propagate `x-session-id` so subagent traffic keeps the correct root session and agent/user semantics.
- **OpenCode via `@ai-sdk/anthropic`**: Point OpenCode at this proxy as an Anthropic provider so Anthropic Messages semantics, premium-request optimizations, and Claude-native behavior are preserved end to end.
- **Claude Code Integration**: Easily configure and launch [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) to use Copilot as its backend with a simple command-line flag (`--claude-code`).
- **Usage Dashboard**: A web-based dashboard to monitor your Copilot API usage, view quotas, and see detailed statistics.
- **Admin UI**: Modern admin console (`/admin`) to inspect account runtime status and request history, with rich filtering and a request-detail JSON viewer (search/copy/download). Includes theme (system/light/dark) and motion (magic/subtle/off) toggles.
- **Rate Limit Control**: Manage API usage with rate-limiting options (`--rate-limit`) and a waiting mechanism (`--wait`) to prevent errors from rapid requests.
- **Manual Request Approval**: Manually approve or deny each API request for fine-grained control over usage (`--manual`).
- **Token Visibility**: Option to display GitHub and Copilot tokens during authentication and refresh for debugging (`--show-token`).
- **Flexible Authentication**: Authenticate interactively or provide a GitHub token directly, suitable for CI/CD environments.
- **Support for Different Account Types**: Works with individual, business, and enterprise GitHub Copilot plans.
- **Multi-Account Support**: Use multiple GitHub Copilot accounts with automatic routing: premium models use accounts in order and fall back on quota exhaustion; free models are distributed round-robin across accounts by default (configurable in config.json).
- **Opencode OAuth Support**: Use opencode GitHub Copilot authentication by setting `COPILOT_API_OAUTH_APP=opencode` environment variable or using `--oauth-app=opencode` command line option.
- **GitHub Enterprise Support**: Connect to GHE.com by setting `COPILOT_API_ENTERPRISE_URL` environment variable (e.g., `company.ghe.com`) or using `--enterprise-url=company.ghe.com` command line option.
- **Custom Data Directory**: Change the default data directory (where tokens and config are stored) by setting `COPILOT_API_HOME` environment variable or using `--api-home=/path/to/dir` command line option.
- **Multi-Provider Anthropic Proxy Routes**: Add global provider configs and call external Anthropic-compatible APIs via `/:provider/v1/messages` and `/:provider/v1/models`.
- **Accurate Claude Token Counting**: Optionally forward `/v1/messages/count_tokens` requests for Claude models to Anthropic's free token counting endpoint for exact counts instead of GPT tokenizer estimation.
- **GPT Context Management**: Configurable context compaction for long-running GPT conversations via `responsesApiContextManagementModels`, reducing unnecessary premium requests when approaching token limits. See [Configuration](#configuration-configjson) for details.

## Better Agent Semantics

### Native Anthropic Messages API when available

For models that advertise Copilot support for `/v1/messages`, this project sends the request to the native Messages API first and only falls back to `/responses` or `/chat/completions` when needed.

Compared with using Claude-family models only through Chat Completions compatibility, the Messages API path keeps more Anthropic-native behavior, including support for:

- `interleaved-thinking-2025-05-14`
- `advanced-tool-use-2025-11-20`
- `context-management-2025-06-27`

Supported `anthropic-beta` values are filtered and forwarded on the native Messages path, and `interleaved-thinking` is added automatically when a thinking budget is requested for non-adaptive extended thinking.

### Fewer unnecessary Premium requests

The proxy includes request-accounting safeguards designed for tool-heavy coding workflows:

- tool-less warmup or probe requests can be forced onto `smallModel` so background checks do not spend premium usage;
- mixed `tool_result` + reminder text blocks are merged back into the `tool_result` flow instead of being counted like fresh user turns;
- `x-initiator` is derived from the latest message or item, not stale assistant history.

This helps resumed tool turns continue the existing workflow instead of consuming an extra Premium request as a brand-new interaction.

### Phase-aware `gpt-5.4` and `gpt-5.3-codex`

By default, the built-in `extraPrompts` for `gpt-5.4` and `gpt-5.3-codex` enable intermediary-update behavior, and the proxy translates assistant turns into `phase: "commentary"` before tool calls and `phase: "final_answer"` for the final response.

That gives clients a short, user-friendly explanation of what the model is about to do before deeper reasoning or tool execution begins.

### Subagent marker integration

For subagent-based clients, this project can preserve root session context and correctly classify subagent-originated traffic.

The marker flow uses `__SUBAGENT_MARKER__...` inside a `<system-reminder>` block together with root `x-session-id` propagation. When a marker is detected, the proxy can keep the parent session identity, infer `x-initiator: agent`, and tag the interaction as subagent traffic instead of a fresh top-level request.

Plugin integrations are included for both Claude Code and opencode; see [Plugin Integrations](#plugin-integrations) below for setup details.

### Accurate Claude token counting

By default, `/v1/messages/count_tokens` estimates Claude token counts using the GPT `o200k_base` tokenizer with a 1.15x multiplier. This consistently underestimates actual Claude token usage, which can cause tools like Claude Code to compact too late and hit "prompt token count exceeds limit" errors.

When an Anthropic API key is configured, the proxy forwards Claude model token counting requests to [Anthropic's real `/v1/messages/count_tokens` endpoint](https://docs.anthropic.com/en/docs/build-with-claude/token-counting) instead. This returns exact counts and eliminates the estimation mismatch. Non-Claude models and failures fall back to the GPT tokenizer estimation automatically.

**Setup:**

1. Create an Anthropic API account at [console.anthropic.com](https://console.anthropic.com) and add a minimum $5 credit balance (required to activate the API key, but the token counting endpoint itself is free)
2. Create an API key from Settings > API Keys
3. Configure the key via **one** of:
   - `config.json`: set `"anthropicApiKey": "sk-ant-..."`
   - Environment variable: `ANTHROPIC_API_KEY=sk-ant-...`

> [!NOTE]
> Anthropic's `/v1/messages/count_tokens` endpoint is **free** (no per-token cost). It is rate-limited to 100 RPM at Tier 1. The $5 credit purchase is only needed to activate API access — the token counting calls themselves cost nothing.

## Demo

https://github.com/user-attachments/assets/7654b383-669d-4eb9-b23c-06d7aefee8c5

## Prerequisites

- Bun (>= 1.2.x)
- GitHub account with Copilot subscription (individual, business, or enterprise)

## Installation

To install dependencies, run:

```sh
bun install
```

## Using with Docker

Build image

```sh
docker build -t copilot-api .
```

Run the container

```sh
# Create a directory on your host to persist the GitHub token and related data
mkdir -p ./copilot-data

# Run the container with a bind mount to persist the token
# This ensures your authentication survives container restarts

docker run -p 4141:4141 -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api
```

> **Note:**
> The GitHub token and related data will be stored in `copilot-data` on your host. This is mapped to `/root/.local/share/copilot-api` inside the container, ensuring persistence across restarts. This directory also stores the admin request history database (`admin.sqlite`) used by `/admin`.

### Adding Multiple Accounts in Docker

To add multiple accounts when running in Docker:

> **Note:** The Docker image uses an entrypoint that runs the `start` command by default. To run `auth` subcommands inside the container, prefix them with `--auth` (e.g. `--auth add`).

```sh
# Add accounts interactively (one at a time)
docker run -it -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api --auth add
docker run -it -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api --auth add

# List registered accounts
docker run -it -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api --auth ls -q
```

> **Note:** When using multiple accounts, all account data (tokens and registry) is stored in the mounted `copilot-data` directory.
> Premium-model requests use accounts in order and automatically switch when premium quota is exhausted; free-model requests are distributed round-robin across accounts by default (configurable in config.json).

### Docker with Environment Variables

You can pass the GitHub token directly to the container using environment variables:

```sh
# Build with GitHub token
docker build --build-arg GH_TOKEN=your_github_token_here -t copilot-api .

# Run with GitHub token
docker run -p 4141:4141 -e GH_TOKEN=your_github_token_here copilot-api

# (Optional) Enable remote admin UI/API access
# This requires setting ADMIN_TOKEN and sending it via request headers (x-admin-token / Authorization: Bearer)
docker run -p 4141:4141 -e GH_TOKEN=your_github_token_here -e ADMIN_TOKEN=your_admin_token_here copilot-api

# (Optional) Enable request authentication
# Preferred: configure auth.apiKeys in config.json.
# Legacy fallback: COPILOT_API_KEY is still supported during migration.
docker run -p 4141:4141 -e GH_TOKEN=your_github_token_here -e COPILOT_API_KEY=your_api_key_here copilot-api

# Run with additional options
docker run -p 4141:4141 -e GH_TOKEN=your_token copilot-api --verbose --port 4141
```

### Docker Compose Example

```yaml
version: "3.8"
services:
  copilot-api:
    build: .
    ports:
      - "4141:4141"
    environment:
      - GH_TOKEN=your_github_token_here
      - ADMIN_TOKEN=your_admin_token_here
      - COPILOT_API_KEY=your_api_key_here
    restart: unless-stopped
```

The Docker image includes:

- Multi-stage build for optimized image size
- Non-root user for enhanced security
- Health check for container monitoring
- Pinned base image version for reproducible builds

## Using with npx

You can run the project directly using npx:

```sh
npx @nick3/copilot-api@latest start
```

With options:

```sh
npx @nick3/copilot-api@latest start --port 8080
```

For authentication only:

```sh
npx @nick3/copilot-api@latest auth
```

## Command Structure

Copilot API now uses a subcommand structure with these main commands:

- `start`: Start the Copilot API server. This command will also handle authentication if needed.
- `auth`: Manage GitHub Copilot accounts. Supports subcommands:
  - `auth add`: Add a new account via GitHub OAuth flow
  - `auth ls`: List all registered accounts (use `-q` to show quota)
  - `auth rm <id|index>`: Remove an account by ID or 1-based index

  Running `auth` without a subcommand defaults to `auth add` for backward compatibility.
- `check-usage`: Show your current GitHub Copilot usage and quota information directly in the terminal (no server required).
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
| --port         | Port to listen on                                                             | 4141       | -p    |
| --verbose      | Enable verbose logging                                                        | false      | -v    |
| --account-type | Account type to use (individual, business, enterprise)                        | individual | -a    |
| --manual       | Enable manual request approval                                                | false      | none  |
| --rate-limit   | Rate limit in seconds between requests                                        | none       | -r    |
| --wait         | Wait instead of error when rate limit is hit                                  | false      | -w    |
| --github-token | Provide GitHub token directly (must be generated using the `auth` subcommand) | none       | -g    |
| --claude-code  | Generate a command to launch Claude Code with Copilot API config              | false      | -c    |
| --show-token   | Show GitHub and Copilot tokens on fetch and refresh                           | false      | none  |
| --proxy-env    | Initialize proxy from environment variables                                   | false      | none  |

### Auth Command Options

The `auth` command has three subcommands for managing multiple accounts:

#### `auth add` - Add a new account

| Option         | Description                                     | Default    | Alias |
| -------------- | ----------------------------------------------- | ---------- | ----- |
| --account-type | Account type (individual, business, enterprise) | individual | -a    |
| --verbose      | Enable verbose logging                          | false      | -v    |
| --show-token   | Show GitHub token after auth                    | false      | none  |

#### `auth ls` - List registered accounts

| Option       | Description                                | Default | Alias |
| ------------ | ------------------------------------------ | ------- | ----- |
| --show-quota | Show quota information (requires API call) | false   | -q    |
| --verbose    | Enable verbose logging                     | false   | -v    |

#### `auth rm <target>` - Remove an account

| Option    | Description              | Default | Alias |
| --------- | ------------------------ | ------- | ----- |
| --force   | Skip confirmation prompt | false   | -f    |
| --verbose | Enable verbose logging   | false   | -v    |

The `<target>` can be either the account ID (GitHub username) or a 1-based index.

### Debug Command Options

| Option | Description               | Default | Alias |
| ------ | ------------------------- | ------- | ----- |
| --json | Output debug info as JSON | false   | none  |

## Configuration (config.json)

- **Location:** `~/.local/share/copilot-api/config.json` (Linux/macOS) or `%USERPROFILE%\.local\share\copilot-api\config.json` (Windows).
- **Default shape:**
  ```json
  {
    "auth": {
      "apiKeys": []
    },
    "providers": {},
    "extraPrompts": {
      "gpt-5-mini": "<built-in exploration prompt>",
      "gpt-5.3-codex": "<built-in commentary prompt>",
      "gpt-5.4-mini": "<built-in commentary prompt>",
      "gpt-5.4": "<built-in commentary prompt>"
    },
    "smallModel": "gpt-5-mini",
    "accountAffinity": true,
    "responsesApiContextManagementModels": [],
    "modelReasoningEfforts": {
      "gpt-5-mini": "low",
      "gpt-5.3-codex": "xhigh",
      "gpt-5.4-mini": "xhigh",
      "gpt-5.4": "xhigh"
    },
    "allowOriginalModelNamesForAliases": false,
    "useFunctionApplyPatch": true,
    "compactUseSmallModel": true,
    "messageStartInputTokensFallback": false,
    "modelRefreshIntervalHours": 24,
    "useMessagesApi": true
  }
  ```
- **auth.apiKeys:** API keys used for request authentication. Supports multiple keys for rotation. Requests can authenticate with either `x-api-key: <key>` or `Authorization: Bearer <key>`. If empty or omitted, authentication is disabled.
- **extraPrompts:** Map of `model -> prompt` appended to the first system prompt when translating Anthropic-style requests to Copilot. Use this to inject guardrails or guidance per model. Missing default entries are auto-added without overwriting your custom prompts. The built-in prompts for `gpt-5.3-codex`, `gpt-5.4-mini`, and `gpt-5.4` enable phase-aware commentary, which lets the model emit a short user-facing progress update before tools or deeper reasoning.
- **providers:** Global upstream provider map. Each provider key (for example `custom`) becomes a route prefix (`/custom/v1/messages`). Currently only `type: "anthropic"` is supported.
  - `enabled` defaults to `true` if omitted.
  - `baseUrl` should be provider API base URL without trailing `/v1/messages`.
  - `apiKey` is used as upstream `x-api-key`.
  - `adjustInputTokens` (optional): When `true`, the proxy will adjust the `input_tokens` in the usage response by subtracting `cache_read_input_tokens` and `cache_creation_input_tokens`.
  - `models` (optional): Per-model configuration map. Each key is a model ID (matching the model name in requests), and the value is:
    - `temperature` (optional): Default temperature value used when the request does not specify one.
    - `topP` (optional): Default top_p value used when the request does not specify one.
    - `topK` (optional): Default top_k value used when the request does not specify one.
- **responsesApiContextManagementModels:** List of model IDs that should receive Responses API `context_management` compaction instructions. Use this when a model supports server-side context management and you want the proxy to keep only the latest compaction carrier on follow-up turns.
- **smallModel:** Fallback model used for tool-less warmup messages, compact/background requests, and other short housekeeping turns (for example from Claude Code or OpenCode) to avoid spending premium requests; defaults to `gpt-5-mini`. If original names are blocked and this points to an aliased target, it resolves to the preferred alias.
- **accountAffinity:** Enable sticky account routing based on session identity. When enabled, requests from the same session for the same model are routed to the account that last handled them successfully. Applies to both free and premium models. Defaults to `true`. Set to `false` to use sequential routing for all models.
- **apiKey (deprecated):** Legacy single-key field kept for migration compatibility. Prefer `auth.apiKeys`. When `auth.apiKeys` is empty, the server falls back to `COPILOT_API_KEY` and then `apiKey`.
- **modelReasoningEfforts:** Per-model `reasoning.effort` sent to the Copilot Responses API. Allowed values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`. If a model isn’t listed, `high` is used by default.
- **modelAliases:** Map of `alias -> { target, allowOriginal? }` (legacy string values are still accepted). Alias keys are normalized (trim + lowercase) and must be non-empty; aliases cannot map to themselves (case-insensitive), and conflicting normalized aliases are rejected. `allowOriginal` overrides the global default per alias. If multiple aliases map to the same target, original names are allowed when any alias sets `allowOriginal: true` (allow-wins). Admin UI/API rejects blocked keys (`__proto__`, `constructor`, `prototype`). Aliases can be used in downstream requests.
- **allowOriginalModelNamesForAliases:** Global default for aliases that omit `allowOriginal`. When `false` (default), targets are blocked unless an alias explicitly allows them; when `true`, targets are allowed unless all aliases explicitly block them.
- **useFunctionApplyPatch:** When `true` (default), `POST /v1/responses` converts a `tools` entry with `{ "type": "custom", "name": "apply_patch" }` into an OpenAI-style `function` tool (with a parameter schema) for upstream compatibility. Set to `false` to leave custom tools untouched.
- **forceAgent:** When `true`, `POST /v1/responses` treats a request as agent-initiated if **any** input item has `role: "assistant"`. When `false` (default), only the **last** input item is checked.
- **compactUseSmallModel:** When `true`, detected "compact" requests (e.g., from Claude Code or opencode compact mode) will automatically use the configured `smallModel` to avoid consuming premium usage for short/background tasks. Defaults to `true`.
- **messageStartInputTokensFallback:** When `true`, the Anthropic streaming translation layer estimates `message_start.input_tokens` when upstream stream events do not provide it. Defaults to `false`.
- **modelRefreshIntervalHours:** Interval for refreshing account model lists in the background. Set to `0` to disable refresh. Defaults to `24`.
- **useMessagesApi:** When `true` (default), Claude-family models that support Copilot's native `/v1/messages` endpoint may use the Messages API path. Set to `false` to skip the Messages API candidate and fall back to `/responses` (if supported) or `/chat/completions`.
- **anthropicApiKey:** Optional Anthropic API key used for accurate Claude token counting (see [Accurate Claude Token Counting](#accurate-claude-token-counting) below). Can also be set via the `ANTHROPIC_API_KEY` environment variable. If not set, token counting falls back to GPT tokenizer estimation.

Edit this file to customize prompts or swap in your own fast model. If you edit it manually, restart the server (or call `GET /api/admin/config`) so the cached config is refreshed. Changes made through the Admin UI/API are validated, written to disk, and applied immediately; unknown keys are rejected.

## API Authentication

- **Protected routes:** All routes except `/`, `/admin`, and `/api/admin/*` require authentication when effective API keys are configured.
- **Effective key resolution:** `auth.apiKeys` (preferred). If empty, fallback to legacy `COPILOT_API_KEY`, then `config.json` `apiKey`.
- **Allowed auth headers:**
  - `x-api-key: <your_key>`
  - `Authorization: Bearer <your_key>`
- **CORS preflight:** `OPTIONS` requests are always allowed.
- **When no keys are configured:** Server starts normally and allows requests (authentication disabled).
- **Admin routes:** `/admin` and `/api/admin/*` are excluded from this middleware and continue using admin-specific access control (`localhost` / `ADMIN_TOKEN`).

Example request:

```sh
curl http://localhost:4141/v1/models \
  -H "x-api-key: your_api_key"
```

## API Endpoints

The server exposes several endpoints to interact with the Copilot API. It provides OpenAI-compatible endpoints and now also includes support for Anthropic-compatible endpoints, allowing for greater flexibility with different tools and services.

### OpenAI Compatible Endpoints

These endpoints mimic the OpenAI API structure.

| Endpoint                    | Method | Description                                                      |
| --------------------------- | ------ | ---------------------------------------------------------------- |
| `POST /v1/responses`        | `POST` | OpenAI Most advanced interface for generating model responses.          |
| `POST /v1/chat/completions` | `POST` | Creates a model response for the given chat conversation.        |
| `GET /v1/models`            | `GET`  | Lists the currently available models.                            |
| `POST /v1/embeddings`       | `POST` | Creates an embedding vector representing the input text.         |

### Anthropic Compatible Endpoints

These endpoints are designed to be compatible with the Anthropic Messages API.

| Endpoint                         | Method | Description                                                  |
| -------------------------------- | ------ | ------------------------------------------------------------ |
| `POST /v1/messages`              | `POST` | Creates a model response for a given conversation.           |
| `POST /v1/messages/count_tokens` | `POST` | Calculates the number of tokens for a given set of messages. |
| `POST /:provider/v1/messages`       | `POST` | Proxies Anthropic Messages API to the configured provider.   |
| `GET /:provider/v1/models`          | `GET`  | Proxies Anthropic Models API to the configured provider.     |
| `POST /:provider/v1/messages/count_tokens` | `POST` | Calculates tokens locally for provider route requests. |

### Usage Monitoring Endpoints

Endpoints for monitoring Copilot account runtime status and per-account usage details.

| Endpoint                    | Method | Description                                                                                     |
| --------------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| `GET /usage`                | `GET`  | Get runtime status snapshots of all loaded accounts (ID, remaining quota, unlimited flag).     |
| `GET /usage/:accountIndex`  | `GET`  | Get detailed Copilot usage for a specific account index (0-based, includes `quota_snapshots`). |
| `GET /token`                | `GET`  | Get the current Copilot token being used by the API.                                            |

> **Note on account indices**
> - `/usage/:accountIndex` is **0-based**.
> - If you start the server with `start --github-token ...`, a temporary account is included and shown as `"(temporary)"` in `GET /usage`. In that case, `accountIndex=0` refers to the temporary account and registered accounts start at `accountIndex=1`.
> - `auth rm <index>` uses a **1-based** index (as shown by `auth ls`).

Example:

```sh
# Account runtime status list
curl "http://localhost:4141/usage"

# Detailed usage for account index 0
curl "http://localhost:4141/usage/0"
```

> **API Key note:** If you enable API key authentication, `/usage` endpoints require `Authorization: Bearer <key>` or `x-api-key`.

### Legacy authentication compatibility

For migration from older deployments, the server still accepts:
- `COPILOT_API_KEY` (env)
- `config.json` `apiKey`

They are used only when `auth.apiKeys` is empty. New setups should use `auth.apiKeys` directly.

### Admin UI & Admin API

The server also exposes a built-in admin UI and API for inspecting account status and request history captured by the proxy.

| Endpoint                            | Method | Description                                                          |
| ----------------------------------- | ------ | -------------------------------------------------------------------- |
| `GET /admin`                        | `GET`  | Built-in admin UI (single-page web app).                             |
| `GET /api/admin/meta`               | `GET`  | Admin DB metadata (db path, retention, etc.).                        |
| `GET /api/admin/accounts`           | `GET`  | List accounts with runtime status and (optional) aggregated stats.    |
| `GET /api/admin/requests`           | `GET`  | Query request logs with filters and cursor pagination.               |
| `GET /api/admin/requests/:requestId`| `GET`  | Get a single request log entry by request ID.                        |

#### Authentication & access

- **Loopback access** is allowed by default when the hostname is `localhost`, `127.0.0.1`, or `::1`.
- **Remote access** is disabled unless you set `ADMIN_TOKEN` on the server.
- When `ADMIN_TOKEN` is set, send the token using one of:
  - `x-admin-token: <token>`
  - `Authorization: Bearer <token>`
- Tokens in URL query parameters are intentionally not supported.

#### Requests query (pagination & filters)

- `limit` defaults to 50 and is clamped to a max of 200.
- `cursor_id` is an integer cursor for pagination (use the `next_cursor_id` from the previous response).
- Filters: `account_id`, `upstream_model`, `client_model`, `upstream_endpoint`, `path`, `status`, `has_error`, `from_ms`, `to_ms`.
- Response fields: `items`, `next_cursor_id`, `has_more`.

## Example Usage

Using with npx:

```sh
# Basic usage with start command
npx @nick3/copilot-api@latest start

# Run on custom port with verbose logging
npx @nick3/copilot-api@latest start --port 8080 --verbose

# Use with a business plan GitHub account
npx @nick3/copilot-api@latest start --account-type business

# Use with an enterprise plan GitHub account
npx @nick3/copilot-api@latest start --account-type enterprise

# Enable manual approval for each request
npx @nick3/copilot-api@latest start --manual

# Set rate limit to 30 seconds between requests
npx @nick3/copilot-api@latest start --rate-limit 30

# Wait instead of error when rate limit is hit
npx @nick3/copilot-api@latest start --rate-limit 30 --wait

# Provide GitHub token directly
npx @nick3/copilot-api@latest start --github-token ghp_YOUR_TOKEN_HERE

# Run only the auth flow
npx @nick3/copilot-api@latest auth

# Run auth flow with verbose logging
npx @nick3/copilot-api@latest auth --verbose

# Add multiple accounts (each account is added in order)
npx @nick3/copilot-api@latest auth add
npx @nick3/copilot-api@latest auth add  # add second account

# List all registered accounts
npx @nick3/copilot-api@latest auth ls

# List accounts with quota information
npx @nick3/copilot-api@latest auth ls -q

# Remove an account by index (1-based)
npx @nick3/copilot-api@latest auth rm 2

# Remove an account by ID (GitHub username)
npx @nick3/copilot-api@latest auth rm octocat

# Show your Copilot usage/quota in the terminal (no server needed)
npx @nick3/copilot-api@latest check-usage

# Display debug information for troubleshooting
npx @nick3/copilot-api@latest debug

# Display debug information in JSON format
npx @nick3/copilot-api@latest debug --json

# Initialize proxy from environment variables (HTTP_PROXY, HTTPS_PROXY, etc.)
npx @nick3/copilot-api@latest start --proxy-env

# Use opencode GitHub Copilot authentication
COPILOT_API_OAUTH_APP=opencode npx @nick3/copilot-api@latest start

# Set custom API home directory via command line
npx @nick3/copilot-api@latest --api-home=/path/to/custom/dir start

# Use GitHub Enterprise via command line
npx @nick3/copilot-api@latest --enterprise-url=company.ghe.com start

# Use opencode OAuth via command line
npx @nick3/copilot-api@latest --oauth-app=opencode start

# Combine multiple global options
npx @nick3/copilot-api@latest --api-home=/custom/path --oauth-app=opencode --enterprise-url=company.ghe.com start
```

### Opencode OAuth Authentication

You can use opencode GitHub Copilot authentication instead of the default one:

```sh
# Set environment variable before running any command
export COPILOT_API_OAUTH_APP=opencode

# Then run start or auth commands
npx @nick3/copilot-api@latest start
npx @nick3/copilot-api@latest auth
```

Or use inline environment variable:

```sh
COPILOT_API_OAUTH_APP=opencode npx @nick3/copilot-api@latest start
```

## Using with OpenCode

OpenCode already has a direct GitHub Copilot provider. Use this section when you want OpenCode to point at this proxy through `@ai-sdk/anthropic` and reuse the agent behaviors described earlier in this README.

### Minimal setup

Start the proxy with the OpenCode OAuth app:

```sh
COPILOT_API_OAUTH_APP=opencode npx @nick3/copilot-api@latest start
```

Then point OpenCode at the proxy with `@ai-sdk/anthropic`.

Example `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "local/gpt-5.4",
  "small_model": "local/gpt-5-mini",
  "agent": {
    "build": {
      "model": "local/gpt-5.4"
    },
    "plan": {
      "model": "local/gpt-5.4"
    },
    "explore": {
      "model": "local/gpt-5-mini"
    }
  },
  "provider": {
    "local": {
      "npm": "@ai-sdk/anthropic",
      "name": "Copilot API Proxy",
      "options": {
        "baseURL": "http://localhost:4141/v1",
        "apiKey": "dummy"
      },
      "models": {
        "gpt-5.4": {
          "name": "gpt-5.4",
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": {
            "context": 272000,
            "output": 128000
          }
        },
        "gpt-5-mini": {
          "name": "gpt-5-mini",
          "limit": {
            "context": 128000,
            "output": 64000
          }
        },
        "claude-sonnet-4.6": {
          "id": "claude-sonnet-4.6",
          "name": "claude-sonnet-4.6",
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },          
          "limit": {
            "context": 128000,
            "output": 32000
          },
          "options": {
            "thinking": {
              "type": "enabled",
              "budgetTokens": 31999
            }
          }
        }
      }
    }
  }
}
```

Why these fields matter:

- `npm: "@ai-sdk/anthropic"` is the important part. OpenCode will speak Anthropic Messages semantics to this proxy instead of flattening everything into OpenAI Chat Completions.
- `options.baseURL` should be `http://localhost:4141/v1`; the Anthropic SDK will append `/messages`, `/models`, and `/messages/count_tokens` automatically.
- `model`, `small_model`, and `agent.*.model` let you keep `gpt-5.4` for build/plan work while routing exploration and background work to `gpt-5-mini`.
- If you enable `auth.apiKeys` in this proxy, replace `dummy` with a real key. Otherwise any placeholder value is fine.

## Using the Usage Viewer

### Admin API examples

```sh
# Loopback access (no token required)
curl "http://localhost:4141/api/admin/meta"

# Enable remote admin UI/API access (server-side)
# ADMIN_TOKEN=your_admin_token_here npx @nick3/copilot-api@latest start

# Remote access (token required)
curl -H "x-admin-token: your_admin_token_here" "http://localhost:4141/api/admin/accounts?include_stats=1"

# Request logs (filters + pagination)
curl "http://localhost:4141/api/admin/requests?limit=50&has_error=1"
# Use next_cursor_id from the response for pagination:
curl "http://localhost:4141/api/admin/requests?limit=50&cursor_id=<next_cursor_id>"

# Single request detail
curl "http://localhost:4141/api/admin/requests/<requestId>"
```

## Using the Admin UI (/admin)

The proxy includes a built-in admin UI served from your running instance. It lets you inspect account status and request history captured by the proxy (models/endpoints, tokens/usage, timing, and error summaries).

1. Start the server. For example, using npx:
    ```sh
    npx @nick3/copilot-api@latest start
    ```
2. Open the UI in your browser:
    - `http://localhost:4141/admin` (replace the port if you changed it)

### UI tips

- **Header controls (top-right)**
  - **Motion**: `Magic` / `Subtle` / `Off` (auto-forced to `Off` when your OS has reduced motion enabled)
  - **Theme**: `System` / `Light` / `Dark`
  - **Admin token**: stored in `sessionStorage` (use the Token dialog to save/test it)
- **Navigation**
  - **Accounts**: KPI overview (incl. error rate, tokens/request), plus filter + sort; click an account to jump into Requests with filters applied.
  - **Requests**: Quick/Advanced filters, time range presets (15m/1h/6h/24h/7d) + custom date/time, cursor pagination.
  - **Request detail**: Back button returns to Requests (preserving filters when navigated from the list); summary fields link back into Requests; JSON viewer supports search/highlight, expand/collapse, and Copy/Download.
- **Deep links**
  - The admin UI uses hash routing, so sharable links look like: `http://localhost:4141/admin/#/requests?...`

### Access control

- When accessing via `localhost` / `127.0.0.1` / `::1`, the admin API is available without a token.
- For non-loopback access (e.g. using a machine IP or hostname), you must enable remote access by setting `ADMIN_TOKEN` on the server and provide the token in requests.

The UI stores the token in `sessionStorage` and sends it as the `x-admin-token` header (it is never placed in the URL).

If you see:
- `403 forbidden`: the admin API is restricted to localhost unless `ADMIN_TOKEN` is set (or the request was blocked as cross-origin).
- `401 unauthorized`: `ADMIN_TOKEN` is set but the request did not include a valid token.

### Data storage (admin.sqlite)

- Request history is stored in `admin.sqlite` under the app data directory:
  - Linux/macOS: `~/.local/share/copilot-api/admin.sqlite`
  - Windows: `%USERPROFILE%\.local\share\copilot-api\admin.sqlite`
- By default, the proxy keeps up to 14 days of logs and caps the DB at 200,000 rows (older entries are cleaned up automatically).
- For safety, the admin DB stores metadata only (no GitHub/Copilot tokens and no request/response content).

## Using with Claude Code

This proxy can be used to power [Claude Code](https://docs.anthropic.com/en/claude-code), an experimental conversational AI assistant for developers from Anthropic.

There are two ways to configure Claude Code to use this proxy:

### Interactive Setup with `--claude-code` flag

To get started, run the `start` command with the `--claude-code` flag:

```sh
npx @nick3/copilot-api@latest start --claude-code
```

You will be prompted to select a primary model and a "small, fast" model for background tasks. After selecting the models, a command will be copied to your clipboard. This command sets the necessary environment variables for Claude Code to use the proxy.

Paste and run this command in a new terminal to launch Claude Code.

> **API Key note:** If request authentication is enabled (prefer `auth.apiKeys`; legacy `COPILOT_API_KEY`/`apiKey` also works), set `ANTHROPIC_AUTH_TOKEN` to one of the configured API keys.

### Manual Configuration with `settings.json`

Alternatively, you can configure Claude Code by creating a `.claude/settings.json` file in your project's root directory. This file should contain the environment variables needed by Claude Code. This way you don't need to run the interactive setup every time.

Here is an example `.claude/settings.json` file:

> **API Key note:** If request authentication is enabled, set `ANTHROPIC_AUTH_TOKEN` to one of your API keys so Claude Code can send `x-api-key`. If not enabled, any value works.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "gpt-5.4",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-5.4",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-5-mini",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false"
  },
  "permissions": {
    "deny": [
      "WebSearch"
    ]
  }
}
```

Replace `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, and `ANTHROPIC_DEFAULT_HAIKU_MODEL` according to your needs. It is recommended to use gpt-5-mini for ANTHROPIC_DEFAULT_HAIKU_MODEL, as gpt-5-mini does not consume quota. ANTHROPIC_DEFAULT_HAIKU_MODEL is typically used for title generation, explore agents, etc.

### CLAUDE.md or AGENTS.md Recommended Content

To add these reminders manually, include the following in `CLAUDE.md` for Claude Code, or `AGENTS.md` for opencode/codex:

```
- Prohibited from directly asking questions to users, MUST use question tool.
- Once you can confirm that the task is complete, MUST use question tool to make user confirm. The user may respond with feedback if they are not satisfied with the result, which you can use to make improvements and try again, after try again, MUST use question tool to make user confirm again.
```

You can find more options here: [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

You can also read more about IDE integration here: [Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

## Plugin Integrations

Plugin integrations are available for Claude Code and opencode.

#### Claude Code plugin integration (marketplace-based)

The Claude Code integration is packaged as a plugin named `claude-plugin`.

- Marketplace catalog in this repository: `.claude-plugin/marketplace.json`
- Plugin source in this repository: `claude-plugin`

Add the marketplace remotely:

```sh
/plugin marketplace add https://github.com/nick3/copilot-api.git#all
```

Install the plugin from the marketplace:

```sh
/plugin install claude-plugin@copilot-api-marketplace
```

After installation, the plugin injects `__SUBAGENT_MARKER__...` on `SubagentStart`, and this proxy uses it to infer `x-initiator: agent`.

The plugin also registers a `UserPromptSubmit` hook that returns `{"continue": true}`, and it can inject `SessionStart` reminder rules through environment variables:

- `CLAUDE_PLUGIN_ENABLE_QUESTION_RULES=1` enables the two reminders about using the `question` tool automatically for Claude Code. Alternatively, you can add the same reminders manually in `CLAUDE.md`; see [CLAUDE.md or AGENTS.md Recommended Content](#claudemd-or-agentsmd-recommended-content).
- `CLAUDE_PLUGIN_ENABLE_NO_BACKGROUND_AGENTS_RULE=1` enables the `run_in_background: true` avoidance reminder for agent hooks.

#### Opencode plugin

The subagent marker producer is packaged as an opencode plugin located at `.opencode/plugins/subagent-marker.js`.

**Installation:**

Copy the plugin file to your opencode plugins directory:

```sh
# Clone or download this repository, then copy the plugin
cp .opencode/plugins/subagent-marker.js ~/.config/opencode/plugins/
```

Or manually create the file at `~/.config/opencode/plugins/subagent-marker.js` with the plugin content.

**Features:**

- Tracks sub-sessions created by subagents
- Automatically prepends a marker system reminder (`__SUBAGENT_MARKER__...`) to subagent chat messages
- Sets `x-session-id` header for session tracking
- Enables this proxy to infer `x-initiator: agent` for subagent-originated requests

The plugin hooks into `session.created`, `session.deleted`, `chat.message`, and `chat.headers` events to provide seamless subagent marker functionality.

## Running from Source

The project can be run from source in several ways:

### Development Mode

```sh
bun run dev
```

### Production Mode

```sh
bun run start
```

## Usage Tips

- To avoid hitting GitHub Copilot's rate limits, you can use the following flags:
  - `--manual`: Enables manual approval for each request, giving you full control over when requests are sent.
  - `--rate-limit <seconds>`: Enforces a minimum time interval between requests. For example, `copilot-api start --rate-limit 30` will ensure there's at least a 30-second gap between requests.
  - `--wait`: Use this with `--rate-limit`. It makes the server wait for the cooldown period to end instead of rejecting the request with an error. This is useful for clients that don't automatically retry on rate limit errors.
- If you have a GitHub business or enterprise plan account with Copilot, use the `--account-type` flag (e.g., `--account-type business`). See the [official documentation](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization) for more details.
- **Multi-account request routing**: Add multiple GitHub Copilot accounts using `auth add`.
  - **Premium models**: Accounts are tried in the order they were added. When an account's premium request quota (`remaining=0`) is exhausted (or insufficient for the selected model), the proxy automatically switches to the next eligible account.
  - **Free models**: When `accountAffinity=true`, requests with the same affinity key and model stick to the account that last handled them successfully. Affinity misses fall back to the first available eligible account. Set `accountAffinity=false` in `config.json` to disable affinity and route all requests sequentially.
  - **Model classification**: Based on Copilot model metadata (`billing.is_premium` / `billing.multiplier`). Missing billing info or `billing.is_premium !== true` is treated as free.
