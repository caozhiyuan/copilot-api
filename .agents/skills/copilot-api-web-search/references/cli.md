# CLI Reference (`scripts/web_search.mjs`)

Set a convenient script variable (works from any working directory):

```bash
export WEB_SEARCH=".agents/skills/copilot-api-web-search/scripts/web_search.mjs"
```

Run with `node` (Node.js 20+) or `bun`.

## Dry run

Preview the resolved endpoint, redacted auth status, and exact JSON payload without sending a network request:

```bash
node "$WEB_SEARCH" search \
  --query "Bun 1.4 release notes" \
  --recency 30 \
  --dry-run
```

## Web search (`search`)

Single or multiple queries in one call:

```bash
node "$WEB_SEARCH" search \
  --query "OpenAI Responses API websocket continuation" \
  --query "copilot-api alpha search" \
  --response-length medium
```

With domain filters, recency, context size, and location:

```bash
node "$WEB_SEARCH" search \
  --query "TypeScript 5.9 release notes" \
  --recency 90 \
  --domain devblogs.microsoft.com \
  --allowed-domain microsoft.com \
  --context-size high \
  --country US \
  --timezone America/Los_Angeles
```

JSON output saved to a file (use the OS temp directory unless saving a workspace artifact):

```bash
node "$WEB_SEARCH" search \
  --query "xAI Grok video API pricing" \
  --format json \
  --out "${TMPDIR:-/tmp}/copilot-api-web-search/xai-video.json"
```

## Multi-turn open, find, and click

Step 1 — search and note the `Session ID` (or pass your own `--session-id`):

```bash
node "$WEB_SEARCH" search \
  --session-id research-01 \
  --query "Hono middleware error handling docs"
```

Step 2 — open a returned `ref_id` (e.g. `turn0search0`) or a direct URL:

```bash
node "$WEB_SEARCH" open \
  --session-id research-01 \
  --ref turn0search0 \
  --lineno 1
```

Step 3 — search inside the opened snapshot (`turn0view0`) or URL:

```bash
node "$WEB_SEARCH" find \
  --session-id research-01 \
  --ref turn0view0 \
  --pattern "onError"
```

Step 4 — follow link `[0]` from the opened snapshot:

```bash
node "$WEB_SEARCH" click \
  --session-id research-01 \
  --ref turn0view0 \
  --link-id 0
```

## Structured lookups (`structured`)

Finance:

```bash
node "$WEB_SEARCH" structured --ticker AAPL --asset-type equity --market US
```

Weather:

```bash
node "$WEB_SEARCH" structured --location "Tokyo" --duration 3
```

Sports:

```bash
node "$WEB_SEARCH" structured --sports-fn standings --league nba
```

Time:

```bash
node "$WEB_SEARCH" structured --utc-offset +08:00
```

## Raw multi-command payload (`raw`)

Combine multiple command types in a single turn:

```bash
node "$WEB_SEARCH" raw \
  --session-id combined-01 \
  --commands-json '{"search_query":[{"q":"Node.js 22 LTS schedule"}],"time":[{"utc_offset":"+00:00"}],"response_length":"short"}'
```

## Targeting a specific gateway or provider

```bash
# Custom gateway URL
COPILOT_API_BASE_URL=http://127.0.0.1:4141 \
  node "$WEB_SEARCH" search --query "copilot-api"

# Explicit provider-scoped route (POST /deepseek/v1/alpha/search)
node "$WEB_SEARCH" search \
  --provider deepseek \
  --model deepseek-flash \
  --query "DeepSeek search API pricing"

# Explicit provider/model alias on top-level /v1/alpha/search
node "$WEB_SEARCH" search \
  --model codex/gpt-5.6-sol \
  --query "Codex CLI release notes"
```
