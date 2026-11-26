# Alpha Search API Reference (`copilot-api`)

## Endpoints

- Top-level: `POST /v1/alpha/search` (alias: `POST /alpha/search`)
- Provider-scoped: `POST /:provider/v1/alpha/search` (alias: `POST /:provider/alpha/search`)

Authentication uses standard `copilot-api` gateway headers (`Authorization: Bearer $GITHUB_COPILOT_API_KEY`). Loopback gateways without `auth.apiKeyConfigs` allow unauthenticated requests; protected and non-loopback gateways require a valid gateway API key.

## Gateway routing rules

1. **Model mapping:** `modelMappings` is applied first on the top-level route.
2. **Explicit `codex/<model>` alias** or `POST /codex/v1/alpha/search`: forwards to native Codex Alpha Search (`https://chatgpt.com/backend-api/codex/alpha/search`) using the gateway's active Codex OAuth session.
3. **Codex priority (`alphaSearchCodexPriority`, default `true`):** If `codex` is configured and available, top-level requests prefer native Codex Alpha Search. Non-`gpt*` model names are normalized to `gpt-6-luna`.
4. **Native DeepSeek Alpha Search:** Explicit `deepseek/<model>` (or `/deepseek/v1/alpha/search`) against the official DeepSeek base URL forwards natively to DeepSeek Alpha Search.
5. **Responses web-search fallback:** When Codex is unavailable and the target is not native DeepSeek:
   - Messages-backed models (Anthropic, Google, OpenAI-compatible, or Copilot models without `/responses`) are redirected to configured `alphaSearchModel` (default `gpt-6-luna`).
   - Supported commands are executed locally (`time`, cached snapshots) or through Responses `web_search`.

## Request contract

Based on `src/routes/alpha-search/alpha-search-types.ts`:

```json
{
  "id": "session-id",
  "model": "gpt-6-luna",
  "commands": {
    "search_query": [{ "q": "query", "recency": 7, "domains": ["example.com"] }],
    "image_query": [{ "q": "query", "recency": 7, "domains": ["example.com"] }],
    "open": [{ "ref_id": "turn0search0", "lineno": 1 }],
    "click": [{ "ref_id": "turn0view0", "id": 0 }],
    "find": [{ "ref_id": "turn0view0", "pattern": "needle" }],
    "screenshot": [{ "ref_id": "turn0view0", "pageno": 0 }],
    "finance": [{ "ticker": "AAPL", "type": "equity", "market": "US" }],
    "weather": [{ "location": "Tokyo", "start": "2026-11-25", "duration": 3 }],
    "sports": [{ "tool": "sports", "fn": "schedule", "league": "nba" }],
    "time": [{ "utc_offset": "+08:00" }],
    "response_length": "short"
  },
  "settings": {
    "search_context_size": "medium",
    "external_web_access": "live",
    "filters": {
      "allowed_domains": ["example.com"],
      "blocked_domains": ["spam.example"]
    },
    "user_location": {
      "type": "approximate",
      "country": "US",
      "region": "CA",
      "city": "San Francisco",
      "timezone": "America/Los_Angeles"
    },
    "image_settings": {
      "max_results": 5,
      "caption": true
    }
  },
  "reasoning": {
    "effort": "low",
    "summary": "concise"
  },
  "max_output_tokens": 4096
}
```

## Response shape

```json
{
  "encrypted_output": null,
  "output": "Grounded answer text and/or snapshot contents...",
  "results": [
    {
      "type": "text_result",
      "domain": "example.com",
      "ref_id": "turn0search0",
      "snippet": "...",
      "title": "Example Page",
      "url": "https://example.com/page"
    }
  ]
}
```

## Fallback limitations & session state

When served by the Responses web-search fallback (`src/routes/alpha-search/alpha-search-responses.ts`):

- Session state (`ref_id`s and page snapshots) is process-local with a 1-hour TTL, up to 128 sessions, 256 URL references per session, and 16 page snapshots (20,000 characters each).
- `image_query` and `screenshot` are unsupported and return warnings without failing the request.
- `external_web_access` only supports live retrieval (`true`, `"live"`, or omitted); `false`, `"cached"`, or `"indexed"` emits a warning and skips remote operations.
- `time` is evaluated locally from the requested `utc_offset` without an upstream call.

## Usage accounting

- Native Codex and DeepSeek alpha-search calls are recorded under `endpoint: "alpha_search"` with model suffix `_search` and `0` tokens (Codex cost `$0`; official DeepSeek billed per operation).
- Requests handled via Responses fallback are recorded under standard Responses usage.
- Passing `--session-id` sets both `payload.id` and `x-codex-turn-metadata.session_id` for accurate session attribution.
