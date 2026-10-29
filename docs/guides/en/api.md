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

The server exposes several OpenAI- and Anthropic-compatible endpoints. Requests can target GitHub Copilot, the built-in `codex` provider, or configured providers depending on the selected model and `provider/model` alias. Provider-scoped paths use the form `/:provider/v1/...` where supported; video endpoints are available only at the top level.

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

These endpoints implement Codex backend APIs. Image requests routed to Codex require an active Codex login; configured provider image routes use that provider's credentials. Alpha search can use either the Codex backend or a Responses web-search adapter.

| Endpoint                                                       | Method | Description                                                     |
| -------------------------------------------------------------- | ------ | --------------------------------------------------------------- |
| `POST /v1/alpha/search`                | `POST` | Routes Codex alpha-search requests to the Codex backend, or handles supported commands locally and through Responses web search. |
| `POST /v1/images/generations` | `POST` | Forwards a JSON image generation request to the Codex Images upstream. When the request omits `Content-Type`, the gateway defaults it to `application/json`. Configured model mappings apply to the request `model`; a mapping that resolves to a `provider/model` alias forwards the request to that provider's images endpoint when the provider is configured. |
| `POST /v1/images/edits` | `POST` | Accepts JSON image references or `multipart/form-data` uploads. JSON requests retain their existing behavior, including `images: [{ image_url }]`, `images: [{ file_id }]`, and an optional `mask` reference. Multipart uploads accept `image`, `image[]`, and repeated image fields in their original order, plus an optional `mask`. Files are staged to disk, then converted to base64 data URLs and JSON for Codex or xAI. Model mappings and `provider/model` aliases apply. `/codex/v1/images/edits` and `/xai/v1/images/edits` also accept multipart; other provider-scoped routes retain their pass-through behavior. |

Multipart uploads are limited to 128 MiB total, 64 MiB per file, and 16 files; exceeding a limit returns `413`, and malformed multipart returns `400`. Temporary files are removed after JSON conversion or on failure/cancellation. Base64 expands image data by about one third, and the generated JSON is buffered before forwarding. xAI retains its 5-image limit and rejects masks, file IDs, and streaming. Other providers selected by model mapping continue to receive multipart uploads.

When `imageGenerationModel` or `imageEditModel` is an `xai/model` alias, that top-level route translates the OpenAI image request and sends it to the enabled `xai` provider's Imagine API. The alias selects the upstream model. An empty setting keeps the OpenAI forwarding path described above. Other providers are not accepted in these two settings.

For requests routed to the Codex backend, the gateway replaces client authorization and account headers with the active Codex login and preserves compatible request metadata. Responses-backed alpha search instead follows the selected Copilot or provider route.

### xAI Video Endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/v1/videos/generations` | `POST` | Submit a native asynchronous video request. Send `model: "xai/grok-imagine-video-1.5"` or a model mapping that resolves to it. Returns the upstream `request_id`. |
| `/v1/videos/{request_id}` | `GET` | Query the xAI job status and video URL using the same account and upstream address as submission. |

Both endpoints also work without `/v1` and use regular gateway authentication. The enabled `xai` provider supplies API-key or OAuth credentials. There is no default model; an absent or unsupported `model` returns `400`, and an unavailable provider returns `404`. Other native generation fields are passed through for upstream validation, including image and reference inputs. Native response bodies, status codes, and metadata are preserved.

Submit a generation request:

```sh
curl http://localhost:4141/v1/videos/generations \
  -H 'Authorization: Bearer your_gateway_key' \
  -H 'Content-Type: application/json' \
  -d '{"model":"xai/grok-imagine-video-1.5","prompt":"A paper boat on a lake","duration":5}'
```

The response contains an upstream `request_id`. Poll for the result using that ID:

```sh
curl http://localhost:4141/v1/videos/YOUR_REQUEST_ID \
  -H 'Authorization: Bearer your_gateway_key'
```

The gateway does not wait for generation, retry submissions, or store jobs. Keep the same xAI account and base URL while querying. Clients handle native statuses such as `pending`, `done`, and `failed`, and access the returned `video.url` directly. Default xAI video URLs are temporary. See the [xAI video documentation](https://docs.x.ai/developers/model-capabilities/video/generation).

### Anthropic Compatible Endpoints

These endpoints are designed to be compatible with the Anthropic Messages API.

| Endpoint                         | Method | Description                                                  |
| -------------------------------- | ------ | ------------------------------------------------------------ |
| `POST /v1/messages`              | `POST` | Creates a model response for a given conversation. Supports `provider/model` aliases for configured providers, including translation through `openai-compatible` and native Google Gemini (`google`) providers. |
| `POST /v1/messages/count_tokens` | `POST` | Calculates the number of tokens for a given set of messages. Supports `provider/model` aliases for configured providers. |

### Usage Monitoring Endpoints

Endpoints for monitoring subscription usage and quotas.

| Endpoint     | Method | Description                                                  |
| ------------ | ------ | ------------------------------------------------------------ |
| `GET /usage` | `GET`  | Get detailed Copilot usage statistics and quota information. |
| `GET /usage/github-copilot` | `GET` | Get normalized Premium, Chat, and Completions subscription quotas. |
| `GET /usage/codex` | `GET` | Get the selected Codex subscription's windows, credits, and Business member credit limit. |
| `GET /usage/xai` | `GET` | Get the selected xAI subscription's Grok Build allowance and prepaid balance. |
| `GET /usage/opencode-go` | `GET` | Get OpenCode Go rolling 5-hour, weekly, and monthly usage percentages and reset times. |

OpenCode Go uses the configured provider API key and base URL to query `GET /v1/usage`; legacy `https://opencode.ai/zen/go` URLs use the existing normalization to `https://opencode.ai/inference/go`. Monetary caps and plan tiers are not inferred from percentages. A workspace without a Go allowance returns 404, matching other unavailable subscriptions.

Subscription endpoints use the server's enabled provider and selected account. They return normalized `provider`, `planType`, `windows`, `credits`, and limit status fields, with `resetAt` in Unix seconds. Copilot calendar reset dates use `resetDate`; individual windows may report `unlimited`. Unavailable subscriptions return 404; upstream or credential failures return 502. The desktop and web Subscriptions tabs query these endpoints independently. Upstream credentials stay on the server.

### Admin / Configuration Endpoints

These endpoints are reserved for local administrative actions and only accept `auth.adminApiKey`.

| Endpoint                              | Method | Description                                                                 |
| ------------------------------------- | ------ | --------------------------------------------------------------------------- |
| `GET /admin/config/model-mappings`    | `GET`  | Returns the current `config.json` path and the active `modelMappings` map.  |
| `POST /admin/config/model-mappings`   | `POST` | Updates only the `modelMappings` field in `config.json` and returns it back. |
| `POST /admin/config/reload` | `POST` | Reloads configuration into the current server process without restarting. |

The reload endpoint requires no request body and returns `{ configPath, reloaded: true }`. After changing the admin key on disk, authenticate the reload with the previous active key. Invalid JSON preserves the last working configuration. The desktop calls this endpoint automatically after saving gateway configuration.
