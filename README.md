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

**Note:** If you are using [opencode](https://github.com/sst/opencode), you do not need this project. Opencode supports GitHub Copilot provider out of the box.

---

## Project Overview

A reverse-engineered proxy for the GitHub Copilot API that exposes it as an OpenAI and Anthropic compatible service. This allows you to use GitHub Copilot with any tool that supports the OpenAI Chat Completions API or the Anthropic Messages API, including to power [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

## Features

- **OpenAI & Anthropic Compatibility**: Exposes GitHub Copilot as an OpenAI-compatible (`/v1/responses`, `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) and Anthropic-compatible (`/v1/messages`) API.
- **Claude Code Integration**: Easily configure and launch [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) to use Copilot as its backend with a simple command-line flag (`--claude-code`).
- **Usage Dashboard**: A web-based dashboard to monitor your Copilot API usage, view quotas, and see detailed statistics.
- **Admin UI**: Modern admin console (`/admin`) to inspect account runtime status and request history, with rich filtering and a request-detail JSON viewer (search/copy/download). Includes theme (system/light/dark) and motion (magic/subtle/off) toggles.
- **Rate Limit Control**: Manage API usage with rate-limiting options (`--rate-limit`) and a waiting mechanism (`--wait`) to prevent errors from rapid requests.
- **Manual Request Approval**: Manually approve or deny each API request for fine-grained control over usage (`--manual`).
- **Token Visibility**: Option to display GitHub and Copilot tokens during authentication and refresh for debugging (`--show-token`).
- **Flexible Authentication**: Authenticate interactively or provide a GitHub token directly, suitable for CI/CD environments.
- **Support for Different Account Types**: Works with individual, business, and enterprise GitHub Copilot plans.
- **Multi-Account Support**: Use multiple GitHub Copilot accounts with automatic routing: premium models use accounts in order and fall back on quota exhaustion; free models are distributed round-robin across accounts by default (configurable in config.json).
- **Opencode OAuth Support**: Use opencode GitHub Copilot authentication by setting `COPILOT_API_OAUTH_APP=opencode` environment variable.
- **GitHub Enterprise Support**: Connect to GHE.com by setting `COPILOT_API_ENTERPRISE_URL` environment variable (e.g., `company.ghe.com`).
- **Custom Data Directory**: Change the default data directory (where tokens and config are stored) by setting `COPILOT_API_HOME` environment variable.
- **Multi-Provider Anthropic Proxy Routes**: Add global provider configs and call external Anthropic-compatible APIs via `/:provider/v1/messages` and `/:provider/v1/models`.

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
    "providers": {
      "openrouter": {
        "type": "anthropic",
        "enabled": true,
        "baseUrl": "https://openrouter.ai/api",
        "apiKey": "sk-your-provider-key",
        "defaultTemperature": 0.7,
        "defaultTopP": 0.9,
        "defaultTopK": 20
      }
    },
    "extraPrompts": {
      "gpt-5-mini": "<built-in exploration prompt>",
      "gpt-5.1-codex-max": "<built-in exploration prompt>"
    },
    "smallModel": "gpt-5-mini",
    "freeModelLoadBalancing": true,
    "modelReasoningEfforts": {
      "gpt-5-mini": "low"
    },
    "modelAliases": {
      "fast": { "target": "gpt-5-mini", "allowOriginal": false },
      "draft": { "target": "gpt-5.1-codex-max" }
    },
    "allowOriginalModelNamesForAliases": false,
    "useFunctionApplyPatch": true,
    "forceAgent": false,
    "compactUseSmallModel": true
  }
  ```
- **auth.apiKeys:** API keys used for request authentication. Supports multiple keys for rotation. Requests can authenticate with either `x-api-key: <key>` or `Authorization: Bearer <key>`. If empty or omitted, authentication is disabled.
- **extraPrompts:** Map of `model -> prompt` appended to the first system prompt when translating Anthropic-style requests to Copilot. Use this to inject guardrails or guidance per model. Missing default entries are auto-added without overwriting your custom prompts.
- **providers:** Global upstream provider map. Each provider key (for example `openrouter`) becomes a route prefix (`/openrouter/v1/messages`). Currently only `type: "anthropic"` is supported.
  - `enabled` defaults to `true` if omitted.
  - `baseUrl` should be provider API base URL without trailing `/v1/messages`.
  - `apiKey` is used as upstream `x-api-key`.
  - `defaultTemperature` (optional): Default temperature value used when the request does not specify one.
  - `defaultTopP` (optional): Default top_p value used when the request does not specify one.
  - `defaultTopK` (optional): Default top_k value used when the request does not specify one.
- **smallModel:** Fallback model used for tool-less warmup messages (e.g., Claude Code probe requests) to avoid spending premium requests; defaults to `gpt-5-mini`. If original names are blocked and this points to an aliased target, it resolves to the first alias.
- **freeModelLoadBalancing:** Enable round-robin routing for free-model requests across multiple accounts. Defaults to `true`. Set to `false` to route free-model requests sequentially (same ordering strategy as premium models).
- **apiKey (deprecated):** Legacy single-key field kept for migration compatibility. Prefer `auth.apiKeys`. When `auth.apiKeys` is empty, the server falls back to `COPILOT_API_KEY` and then `apiKey`.
- **modelReasoningEfforts:** Per-model `reasoning.effort` sent to the Copilot Responses API. Allowed values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`. If a model isn’t listed, `high` is used by default.
- **modelAliases:** Map of `alias -> { target, allowOriginal? }` (legacy string values are still accepted). Alias keys are normalized (trim + lowercase) and must be non-empty; aliases cannot map to themselves (case-insensitive), and conflicting normalized aliases are rejected. `allowOriginal` overrides the global default per alias. If multiple aliases map to the same target, original names are allowed when any alias sets `allowOriginal: true` (allow-wins). Admin UI/API rejects blocked keys (`__proto__`, `constructor`, `prototype`). Aliases can be used in downstream requests.
- **allowOriginalModelNamesForAliases:** Global default for aliases that omit `allowOriginal`. When `false` (default), targets are blocked unless an alias explicitly allows them; when `true`, targets are allowed unless all aliases explicitly block them.
- **useFunctionApplyPatch:** When `true` (default), `POST /v1/responses` converts a `tools` entry with `{ "type": "custom", "name": "apply_patch" }` into an OpenAI-style `function` tool (with a parameter schema) for upstream compatibility. Set to `false` to leave custom tools untouched.
- **forceAgent:** When `true`, `POST /v1/responses` treats a request as agent-initiated if **any** input item has `role: "assistant"`. When `false` (default), only the **last** input item is checked.
- **compactUseSmallModel:** When `true`, detected "compact" requests (e.g., from Claude Code or opencode compact mode) will automatically use the configured `smallModel` to avoid consuming premium usage for short/background tasks. Defaults to `true`.

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
    "ANTHROPIC_MODEL": "gpt-5.2",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-5.2",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-5-mini",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "BASH_MAX_TIMEOUT_MS": "600000",
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

### CLAUDE.md Recommended Content

Please include the following in `CLAUDE.md` (for Claude usage):

- Prohibited from directly asking questions to users, MUST use AskUserQuestion tool.
- Once you can confirm that the task is complete, MUST use AskUserQuestion tool to make user confirm. The user may respond with feedback if they are not satisfied with the result, which you can use to make improvements and try again.

You can find more options here: [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

You can also read more about IDE integration here: [Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

### Subagent Marker Integration (Optional)

This project supports `x-initiator: agent` for subagent-originated requests.

#### Claude Code plugin producer (marketplace-based)

The marker producer is packaged as a Claude Code plugin named `claude-plugin`.

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

#### Opencode plugin producer

The marker producer is packaged as an opencode plugin located at `.opencode/plugins/subagent-marker.js`.

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
  - **Free models**: By default, requests are distributed round-robin across all eligible accounts (including the temporary account created via `start --github-token ...`). Set `freeModelLoadBalancing=false` in `config.json` to disable this and route free-model requests sequentially.
  - **Model classification**: Based on Copilot model metadata (`billing.is_premium` / `billing.multiplier`). Missing billing info or `billing.is_premium !== true` is treated as free.
