# Codex

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/codex.md)

## Using with Codex

This AI gateway can also power Codex.

Recommended Codex version: `0.155.1`.

### Codex `config.toml` Reference

Add this to `~/.codex/config.toml`:

```toml
model = "gpt-6.1-sol"
model_reasoning_effort = "max"
model_provider = "copilot_api"
model_reasoning_summary = "auto"
plan_mode_reasoning_effort = "max"
model_context_window = 272000
model_auto_compact_token_limit = 244800
# Sandbox policy. Use "workspace-write" to restrict it.
sandbox_mode = "danger-full-access"
approvals_reviewer = "auto_review"
suppress_unstable_features_warning = true
web_search = "live"
service_tier = "default"
# Codex 0.156.0 and later: generate the catalog, then uncomment this line.
# model_catalog_json = "model_catalog.json"

[model_providers.copilot_api]
name = "OpenAI"
base_url = "http://localhost:4141"
model_catalog_url = "http://localhost:4141/models"
env_key = "GITHUB_COPILOT_API_KEY"
requires_openai_auth = true
supports_websockets = false
supports_standalone_web_search = true
wire_api = "responses"
request_max_retries = 3
stream_max_retries = 3
stream_idle_timeout_ms = 300000

[features]
remote_compaction_v2 = true
api_key_model_discovery = true
default_mode_request_user_input = true
standalone_web_search = true
daemon_auto_start = false
apps = false

[analytics]
enabled = false
```

> [!NOTE]
> `name` must be set to `"OpenAI"`.

### Auto Review Model Mapping

When using `approvals_reviewer = "auto_review"` through the top-level GitHub Copilot route, add this mapping to the gateway's `config.json`:

```json
{
  "modelMappings": {
    "codex-auto-review": "gpt-5.6-luna"
  }
}
```

Alternatively, set `"codex-auto-review": "codex/codex-auto-review"` to use the built-in `codex` provider.

### Generate `model_catalog.json`

**Codex `0.156.0+`:** `api_key_model_discovery` loads the model list successfully, but Codex has a bug. Use a local catalog as a workaround; this also works when signed out of a GPT account. Earlier versions do not need `model_catalog_json`.

Start the gateway, install `curl` and Bun or Node.js, then run [the generator](../../generate-model-catalog.sh) from the repository root:

```sh
sh docs/generate-model-catalog.sh
```

Defaults: gateway `http://localhost:4141`, output `$HOME/.codex/model_catalog.json`. To customize, append the gateway URL and output path in that order.

- **Authentication:** If enabled, export `GITHUB_COPILOT_API_KEY` before running the script.
- **Configuration:** After generation, uncomment `model_catalog_json` and set it to the file's absolute path.
- **Updates:** Rerun the script and restart Codex after changing gateway models or providers.

### Codex Model Catalog and Protocol Adapters

Codex's model picker includes models from the gateway's configured providers:

<img src="../../screenshots/codex-models.png" alt="Codex model picker showing models provided by the gateway" width="900" />

> **Model switching:** Start a new Codex session when switching between DeepSeek and Responses Lite models.

---
