# API and Authentication

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/api.md)

## API Authentication

- **Protected non-admin routes:** All routes except `/`, `/usage-viewer`, and `/usage-viewer/` require authentication when `auth.apiKeys` is configured and non-empty. Non-loopback listeners require a non-empty `auth.apiKeys` configuration at startup and continue failing closed if the keys are later cleared.
- **Admin routes:** All `/admin/*` routes require `auth.adminApiKey`. If it is missing, the server generates one at startup and persists it to `config.json` before serving requests.
- **Allowed auth headers:**
  - `x-api-key: <your_key>`
  - `Authorization: Bearer <your_key>`
- **CORS preflight:** `OPTIONS` requests are always allowed.
- **When no regular keys are configured:** Non-admin routes continue to allow requests. This does not apply to `/admin/*`, which only accepts `auth.adminApiKey`.

Example request for a regular protected route:

```sh
curl http://localhost:4141/v1/models \
  -H "x-api-key: your_api_key"
```

Example request for an admin route:

```sh
curl http://localhost:4141/admin/config/model-mappings \
  -H "x-api-key: your_admin_api_key"
```

## API Endpoints

The server exposes several OpenAI- and Anthropic-compatible endpoints. Requests can target GitHub Copilot, the built-in `codex` provider, or configured providers depending on the selected model and `provider/model` alias. Every `/v1/...` endpoint below also supports a provider-scoped path in the form `/:provider/v1/...`; those variants are omitted from the tables.

### OpenAI Compatible Endpoints

These endpoints mimic the OpenAI API structure.

| Endpoint                    | Method | Description                                                      |
| --------------------------- | ------ | ---------------------------------------------------------------- |
| `POST /v1/responses`        | `POST` | OpenAI Most advanced interface for generating model responses. Supports `Content-Encoding: zstd` request bodies and `provider/model` aliases for `openai-responses` providers. Zstd request decompression is limited to Responses routes, including provider-scoped aliases. |
| `POST /v1/chat/completions` | `POST` | Creates a model response for the given chat conversation. Supports `provider/model` aliases for `openai-compatible` providers and can be used without Copilot when the target provider is configured. |
| `GET /v1/models`            | `GET`  | Lists Copilot models plus enabled provider models using `provider/model-id` IDs. Requests from Codex clients (`User-Agent` beginning with `codex`) are forwarded to the Codex Models upstream. |
| `POST /v1/embeddings`       | `POST` | Creates an embedding vector representing the input text.         |

### Model Discovery Sources

`GET /models`, `GET /v1/models`, and `GET /:provider/v1/models` read `xai`, `openrouter`, `deepseek`, `kimi`, `dashscope`, and `opencode-go` models from the models.dev cache without querying those providers' model endpoints. Kimi defaults to `kimi-code-plan-cn` and DashScope to `alibaba-cn`; other official URLs select their matching catalogs. Explicit `modelsDevProviderId` takes priority.

Models missing from the catalog receive no built-in entries. A provider-scoped request with no valid cached models returns `503` (`service_unavailable`); aggregation skips empty catalogs. Capabilities, limits, and USD prices come from the catalog, with explicit model settings taking priority.

All models.dev lists exclude deprecated models and those released before `2026-05-01`, including explicit display selections. Models without a valid `release_date` remain listed.

The Codex model catalog, Copilot model cache, and other custom providers retain their existing remote discovery behavior.

### Codex Backend Endpoints

These endpoints implement Codex backend APIs. Top-level image requests require an active Codex login; alpha search can use either the Codex backend or a Responses web-search adapter.

| Endpoint                                                       | Method | Description                                                     |
| -------------------------------------------------------------- | ------ | --------------------------------------------------------------- |
| `POST /v1/alpha/search`                | `POST` | Routes Codex alpha-search requests to the Codex backend, or handles supported commands locally and through Responses web search. |
| `POST /v1/images/generations` | `POST` | Forwards a JSON image generation request to the Codex Images upstream. When the request omits `Content-Type`, the gateway defaults it to `application/json`. Configured model mappings apply to the request `model`; a mapping that resolves to a `provider/model` alias forwards the request to that provider's images endpoint when the provider is configured. |
| `POST /v1/images/edits` | `POST` | Forwards an image edit request to the Codex Images upstream. Send this request as `multipart/form-data` and let the HTTP client generate the `boundary`. The gateway streams uploaded files to temporary disk files while receiving them and forwards them from disk, so large uploads are not held in memory. Multipart requests are limited to 128 MiB total, 64 MiB per file, and 16 files; requests over a limit return `413`. Model mappings and `provider/model` alias routing apply to this endpoint as well. |

For requests routed to the Codex backend, the gateway replaces client authorization and account headers with the active Codex login and preserves compatible request metadata. Responses-backed alpha search instead follows the selected Copilot or provider route.

### Anthropic Compatible Endpoints

These endpoints are designed to be compatible with the Anthropic Messages API.

| Endpoint                         | Method | Description                                                  |
| -------------------------------- | ------ | ------------------------------------------------------------ |
| `POST /v1/messages`              | `POST` | Creates a model response for a given conversation. Supports `provider/model` aliases for configured providers, including translation through `openai-compatible` providers. |
| `POST /v1/messages/count_tokens` | `POST` | Calculates the number of tokens for a given set of messages. Supports `provider/model` aliases for configured providers. |

### Usage Monitoring Endpoints

New endpoints for monitoring your Copilot usage and quotas.

| Endpoint     | Method | Description                                                  |
| ------------ | ------ | ------------------------------------------------------------ |
| `GET /usage` | `GET`  | Get detailed Copilot usage statistics and quota information. |

### Admin / Configuration Endpoints

These endpoints are reserved for local administrative actions and only accept `auth.adminApiKey`.

| Endpoint                              | Method | Description                                                                 |
| ------------------------------------- | ------ | --------------------------------------------------------------------------- |
| `GET /admin/config/model-mappings`    | `GET`  | Returns the current `config.json` path and the active `modelMappings` map.  |
| `POST /admin/config/model-mappings`   | `POST` | Updates only the `modelMappings` field in `config.json` and returns it back. |
| `POST /admin/config/reload` | `POST` | Reloads configuration into the current server process without restarting. |

The reload endpoint requires no request body and returns `{ configPath, reloaded: true }`. After changing the admin key on disk, authenticate the reload with the previous active key. Invalid JSON preserves the last working configuration. The desktop calls this endpoint automatically after saving gateway configuration.
