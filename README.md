# Copilot API Proxy

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
> [opencode](https://github.com/sst/opencode) already ships with a built-in GitHub Copilot provider, so you may not need this project for basic usage. This proxy is still useful if you want OpenCode to talk to Copilot through `@ai-sdk/anthropic`, preserve Anthropic Messages semantics for tool use, prefer the native Messages API over plain Chat Completions for Claude-family models, use `gpt-5.4` phase-aware commentary, or fine-tune premium-request usage with small-model fallbacks.

---

## Project Overview

A reverse-engineered proxy for the GitHub Copilot API that exposes it as an OpenAI and Anthropic compatible service. This allows you to use GitHub Copilot with any tool that supports the OpenAI Chat Completions API or the Anthropic Messages API, including to power [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

Compared with routing everything through plain Chat Completions compatibility, this proxy can prefer Copilot's native Anthropic-style Messages API for Claude-family models, preserve more native thinking/tool semantics, reduce unnecessary Premium request consumption on warmup or resumed tool turns, and expose phase-aware `gpt-5.4` / `gpt-5.3-codex` responses that are easier for users to follow.

## Features

- **OpenAI & Anthropic Compatibility**: Exposes GitHub Copilot as an OpenAI-compatible (`/v1/responses`, `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) and Anthropic-compatible (`/v1/messages`) API.
- **Anthropic-First Routing for Claude Models**: When a model supports Copilot's native `/v1/messages` endpoint, the proxy prefers it over `/responses` or `/chat/completions`, preserving Anthropic-style `tool_use` / `tool_result` flows and more Claude-native behavior.
- **Fewer Unnecessary Premium Requests**: Reduces wasted premium usage by routing warmup and compact/background requests to `smallModel`, merging `tool_result` follow-ups back into the tool flow, and treating resumed tool turns as continuation traffic instead of fresh premium interactions.
- **Phase-Aware `gpt-5.4` and `gpt-5.3-codex`**: These models can emit user-friendly commentary before deeper reasoning or tool use, so long-running coding actions are easier to understand instead of appearing as a sudden tool burst.
- **Claude Native Beta Support**: On the Messages API path, supports Anthropic-native capabilities such as `interleaved-thinking`, `advanced-tool-use`, and `context-management`, which are difficult or unavailable through plain Chat Completions compatibility.
- **Subagent Marker Integration**: Optional Claude Code and opencode plugins can inject `__SUBAGENT_MARKER__...` and propagate `x-session-id` so subagent traffic keeps the correct root session and agent/user semantics.
- **OpenCode via `@ai-sdk/anthropic`**: Point OpenCode at this proxy as an Anthropic provider so Anthropic Messages semantics, premium-request optimizations, and Claude-native behavior are preserved end to end.
- **Claude Code Integration**: Easily configure and launch [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) to use Copilot as its backend with a simple command-line flag (`--claude-code`).
- **Usage Dashboard**: A web-based dashboard to monitor your Copilot API usage, view quotas, and see detailed statistics.
- **Rate Limit Control**: Manage API usage with rate-limiting options (`--rate-limit`) and a waiting mechanism (`--wait`) to prevent errors from rapid requests.
- **Manual Request Approval**: Manually approve or deny each API request for fine-grained control over usage (`--manual`).
- **Token Visibility**: Option to display GitHub and Copilot tokens during authentication and refresh for debugging (`--show-token`).
- **Flexible Authentication**: Authenticate interactively or provide a GitHub token directly, suitable for CI/CD environments.
- **Support for Different Account Types**: Works with individual, business, and enterprise GitHub Copilot plans.
- **Opencode OAuth Support**: Use opencode GitHub Copilot authentication by setting `COPILOT_API_OAUTH_APP=opencode` environment variable or using `--oauth-app=opencode` command line option.
- **GitHub Enterprise Support**: Connect to GHE.com by setting `COPILOT_API_ENTERPRISE_URL` environment variable (e.g., `company.ghe.com`) or using `--enterprise-url=company.ghe.com` command line option.
- **Custom Data Directory**: Change the default data directory (where tokens and config are stored) by setting `COPILOT_API_HOME` environment variable or using `--api-home=/path/to/dir` command line option.
- **Multi-Provider Anthropic Proxy Routes**: Add global provider configs and call external Anthropic-compatible APIs via `/:provider/v1/messages` and `/:provider/v1/models`.

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
- compact/background requests can be downgraded to `smallModel` automatically;
- mixed `tool_result` + reminder text blocks are merged back into the `tool_result` flow instead of being counted like fresh user turns;
- `x-initiator` is derived from the latest message or item, not stale assistant history.

This helps resumed tool turns continue the existing workflow instead of consuming an extra Premium request as a brand-new interaction.

### Phase-aware `gpt-5.4` and `gpt-5.3-codex`

By default, the built-in `extraPrompts` for `gpt-5.4` and `gpt-5.3-codex` enable intermediary-update behavior, and the proxy translates assistant turns into `phase: "commentary"` before tool calls and `phase: "final_answer"` for the final response.

That gives clients a short, user-friendly explanation of what the model is about to do before deeper reasoning or tool execution begins.

### Subagent marker integration

For subagent-based clients, this project can preserve root session context and correctly classify subagent-originated traffic.

The marker flow uses `__SUBAGENT_MARKER__...` inside a `<system-reminder>` block together with root `x-session-id` propagation. When a marker is detected, the proxy can keep the parent session identity, infer `x-initiator: agent`, and tag the interaction as subagent traffic instead of a fresh top-level request.

Optional marker producers are included for both Claude Code and opencode; see [Subagent Marker Integration](#subagent-marker-integration-optional) below for setup details.

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
> The GitHub token and related data will be stored in `copilot-data` on your host. This is mapped to `/root/.local/share/copilot-api` inside the container, ensuring persistence across restarts.

### Docker with Environment Variables

You can pass the GitHub token directly to the container using environment variables:

```sh
# Build with GitHub token
docker build --build-arg GH_TOKEN=your_github_token_here -t copilot-api .

# Run with GitHub token
docker run -p 4141:4141 -e GH_TOKEN=your_github_token_here copilot-api

# Run with additional options
docker run -p 4141:4141 -e GH_TOKEN=your_token copilot-api start --verbose --port 4141
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
npx @jeffreycao/copilot-api@latest start
```

With options:

```sh
npx @jeffreycao/copilot-api@latest start --port 8080
```

For authentication only:

```sh
npx @jeffreycao/copilot-api@latest auth
```

## Command Structure

Copilot API now uses a subcommand structure with these main commands:

- `start`: Start the Copilot API server. This command will also handle authentication if needed.
- `auth`: Run GitHub authentication flow without starting the server. This is typically used if you need to generate a token for use with the `--github-token` option, especially in non-interactive environments.
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

| Option       | Description               | Default | Alias |
| ------------ | ------------------------- | ------- | ----- |
| --verbose    | Enable verbose logging    | false   | -v    |
| --show-token | Show GitHub token on auth | false   | none  |

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
      "custom": {
        "type": "anthropic",
        "enabled": true,
        "baseUrl": "your-base-url",
        "apiKey": "sk-your-provider-key",
        "adjustInputTokens": false,
        "models": {
          "kimi-k2.5": {
            "temperature": 1,
            "topP": 0.95
          }
        }
      }
    },
    "extraPrompts": {
      "gpt-5-mini": "<built-in exploration prompt>",
      "gpt-5.3-codex": "<built-in commentary prompt>",
      "gpt-5.4": "<built-in commentary prompt>"
    },
    "smallModel": "gpt-5-mini",
    "responsesApiContextManagementModels": [],
    "modelReasoningEfforts": {
      "gpt-5-mini": "low",
      "gpt-5.3-codex": "xhigh",
      "gpt-5.4": "xhigh"
    },
    "useFunctionApplyPatch": true,
    "useMessagesApi": true
  }
  ```
- **auth.apiKeys:** API keys used for request authentication. Supports multiple keys for rotation. Requests can authenticate with either `x-api-key: <key>` or `Authorization: Bearer <key>`. If empty or omitted, authentication is disabled.
- **extraPrompts:** Map of `model -> prompt` appended to the first system prompt when translating Anthropic-style requests to Copilot. Use this to inject guardrails or guidance per model. Missing default entries are auto-added without overwriting your custom prompts. The built-in prompts for `gpt-5.3-codex` and `gpt-5.4` enable phase-aware commentary, which lets the model emit a short user-facing progress update before tools or deeper reasoning.
- **providers:** Global upstream provider map. Each provider key (for example `custom`) becomes a route prefix (`/custom/v1/messages`). Currently only `type: "anthropic"` is supported.
  - `enabled` defaults to `true` if omitted.
  - `baseUrl` should be provider API base URL without trailing `/v1/messages`.
  - `apiKey` is used as upstream `x-api-key`.
  - `adjustInputTokens` (optional): When `true`, the proxy will adjust the `input_tokens` in the usage response by subtracting `cache_read_input_tokens` and `cache_creation_input_tokens`. 
  - `models` (optional): Per-model configuration map. Each key is a model ID (matching the model name in requests), and the value is:
    - `temperature` (optional): Default temperature value used when the request does not specify one.
    - `topP` (optional): Default top_p value used when the request does not specify one.
    - `topK` (optional): Default top_k value used when the request does not specify one.
- **smallModel:** Fallback model used for tool-less warmup messages (e.g., Claude Code probe requests) to avoid spending premium requests; defaults to gpt-5-mini.
- **responsesApiContextManagementModels:** List of model IDs that should receive Responses API `context_management` compaction instructions. Use this when a model supports server-side context management and you want the proxy to keep only the latest compaction carrier on follow-up turns.
- **modelReasoningEfforts:** Per-model `reasoning.effort` sent to the Copilot Responses API. Allowed values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`. If a model isn’t listed, `high` is used by default.
- **useFunctionApplyPatch:** When `true`, the server will convert any custom tool named `apply_patch` in Responses payloads into an OpenAI-style function tool (`type: "function"`) with a parameter schema so assistants can call it using function-calling semantics to edit files. Set to `false` to leave tools unchanged. Defaults to `true`.
- **useMessagesApi:** When `true`, Claude-family models that support Copilot's native `/v1/messages` endpoint will use the Messages API; otherwise they fall back to `/chat/completions`. Set to `false` to disable Messages API routing and always use `/chat/completions`. Defaults to `true`.

Edit this file to customize prompts or swap in your own fast model. Restart the server (or rerun the command) after changes so the cached config is refreshed.

## API Authentication

- **Protected routes:** All routes except `/` require authentication when `auth.apiKeys` is configured and non-empty.
- **Allowed auth headers:**
  - `x-api-key: <your_key>`
  - `Authorization: Bearer <your_key>`
- **CORS preflight:** `OPTIONS` requests are always allowed.
- **When no keys are configured:** Server starts normally and allows requests (authentication disabled).

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

New endpoints for monitoring your Copilot usage and quotas.

| Endpoint     | Method | Description                                                  |
| ------------ | ------ | ------------------------------------------------------------ |
| `GET /usage` | `GET`  | Get detailed Copilot usage statistics and quota information. |
| `GET /token` | `GET`  | Get the current Copilot token being used by the API.         |

## Example Usage

Using with npx:

```sh
# Basic usage with start command
npx @jeffreycao/copilot-api@latest start

# Run on custom port with verbose logging
npx @jeffreycao/copilot-api@latest start --port 8080 --verbose

# Use with a business plan GitHub account
npx @jeffreycao/copilot-api@latest start --account-type business

# Use with an enterprise plan GitHub account
npx @jeffreycao/copilot-api@latest start --account-type enterprise

# Enable manual approval for each request
npx @jeffreycao/copilot-api@latest start --manual

# Set rate limit to 30 seconds between requests
npx @jeffreycao/copilot-api@latest start --rate-limit 30

# Wait instead of error when rate limit is hit
npx @jeffreycao/copilot-api@latest start --rate-limit 30 --wait

# Provide GitHub token directly
npx @jeffreycao/copilot-api@latest start --github-token ghp_YOUR_TOKEN_HERE

# Run only the auth flow
npx @jeffreycao/copilot-api@latest auth

# Run auth flow with verbose logging
npx @jeffreycao/copilot-api@latest auth --verbose

# Show your Copilot usage/quota in the terminal (no server needed)
npx @jeffreycao/copilot-api@latest check-usage

# Display debug information for troubleshooting
npx @jeffreycao/copilot-api@latest debug

# Display debug information in JSON format
npx @jeffreycao/copilot-api@latest debug --json

# Initialize proxy from environment variables (HTTP_PROXY, HTTPS_PROXY, etc.)
npx @jeffreycao/copilot-api@latest start --proxy-env

# Use opencode GitHub Copilot authentication
COPILOT_API_OAUTH_APP=opencode npx @jeffreycao/copilot-api@latest start

# Set custom API home directory via command line
npx @jeffreycao/copilot-api@latest --api-home=/path/to/custom/dir start

# Use GitHub Enterprise via command line
npx @jeffreycao/copilot-api@latest --enterprise-url=company.ghe.com start

# Use opencode OAuth via command line
npx @jeffreycao/copilot-api@latest --oauth-app=opencode start

# Combine multiple global options
npx @jeffreycao/copilot-api@latest --api-home=/custom/path --oauth-app=opencode --enterprise-url=company.ghe.com start
```

### Opencode OAuth Authentication

You can use opencode GitHub Copilot authentication instead of the default one:

```sh
# Set environment variable before running any command
export COPILOT_API_OAUTH_APP=opencode

# Then run start or auth commands
npx @jeffreycao/copilot-api@latest start
npx @jeffreycao/copilot-api@latest auth
```

Or use inline environment variable:

```sh
COPILOT_API_OAUTH_APP=opencode npx @jeffreycao/copilot-api@latest start
```

## Using with OpenCode

OpenCode already has a direct GitHub Copilot provider. Use this section when you want OpenCode to point at this proxy through `@ai-sdk/anthropic` and reuse the agent behaviors described earlier in this README.

### Minimal setup

Start the proxy with the OpenCode OAuth app:

```sh
COPILOT_API_OAUTH_APP=opencode npx @jeffreycao/copilot-api@latest start
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

After starting the server, a URL to the Copilot Usage Dashboard will be displayed in your console. This dashboard is a web interface for monitoring your API usage.

1.  Start the server. For example, using npx:
    ```sh
    npx @jeffreycao/copilot-api@latest start
    ```
2.  The server will output a URL to the usage viewer. Copy and paste this URL into your browser. It will look something like this:
    `http://localhost:4141/usage-viewer?endpoint=http://localhost:4141/usage`
    - If you use the `start.bat` script on Windows, this page will open automatically.

The dashboard provides a user-friendly interface to view your Copilot usage data:

- **API Endpoint URL**: The dashboard is pre-configured to fetch data from your local server endpoint via the URL query parameter. You can change this URL to point to any other compatible API endpoint.
- **Fetch Data**: Click the "Fetch" button to load or refresh the usage data. The dashboard will automatically fetch data on load.
- **Usage Quotas**: View a summary of your usage quotas for different services like Chat and Completions, displayed with progress bars for a quick overview.
- **Detailed Information**: See the full JSON response from the API for a detailed breakdown of all available usage statistics.
- **URL-based Configuration**: You can also specify the API endpoint directly in the URL using a query parameter. This is useful for bookmarks or sharing links. For example:
  `http://localhost:4141/usage-viewer?endpoint=http://your-api-server/usage`

## Using with Claude Code

This proxy can be used to power [Claude Code](https://docs.anthropic.com/en/claude-code), an experimental conversational AI assistant for developers from Anthropic.

There are two ways to configure Claude Code to use this proxy:

### Interactive Setup with `--claude-code` flag

To get started, run the `start` command with the `--claude-code` flag:

```sh
npx @jeffreycao/copilot-api@latest start --claude-code
```

You will be prompted to select a primary model and a "small, fast" model for background tasks. After selecting the models, a command will be copied to your clipboard. This command sets the necessary environment variables for Claude Code to use the proxy.

Paste and run this command in a new terminal to launch Claude Code.

### Manual Configuration with `settings.json`

Alternatively, you can configure Claude Code by creating a `.claude/settings.json` file in your project's root directory. This file should contain the environment variables needed by Claude Code. This way you don't need to run the interactive setup every time.

Here is an example `.claude/settings.json` file:

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

You can find more options here: [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

You can also read more about IDE integration here: [Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

## Subagent Marker Integration (Optional)

This project supports `x-initiator: agent` for subagent-originated requests and can preserve the root session identity with `x-session-id` when a subagent marker is present.

#### Claude Code plugin producer (marketplace-based)

The marker producer is packaged as a Claude Code plugin named `claude-plugin`.

- Marketplace catalog in this repository: `.claude-plugin/marketplace.json`
- Plugin source in this repository: `claude-plugin`

Add the marketplace remotely:

```sh
/plugin marketplace add https://github.com/caozhiyuan/copilot-api.git#all
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

### CLAUDE.md or AGENTS.md Recommended Content

Please include the following in `CLAUDE.md` or `AGENTS.md`:

```
- Prohibited from directly asking questions to users, MUST use question tool.
- Once you can confirm that the task is complete, MUST use question tool to make user confirm. The user may respond with feedback if they are not satisfied with the result, which you can use to make improvements and try again, after try again, MUST use question tool to make user confirm again.
```
