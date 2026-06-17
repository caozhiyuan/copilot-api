# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
bun install          # Install dependencies
bun run dev          # Dev mode with watch
bun run build        # Build to dist/ via tsdown
bun run start        # Production start (NODE_ENV=production)
bun run lint         # ESLint with cache (auto-fixes staged files pre-commit)
bun run lint:all     # ESLint on entire project
bun run typecheck    # tsc type check only (no emit)
bun test             # Run all tests
bun test tests/foo.test.ts  # Run a single test file
```

## Architecture

This is a reverse-engineered proxy that exposes the GitHub Copilot API as both an OpenAI-compatible and Anthropic-compatible HTTP service. The entry point is `src/main.ts` (CLI via `citty`), which dispatches to subcommands: `start`, `auth`, `check-usage`, `debug`.

### Request flow for `/v1/messages` (Anthropic path)

`src/routes/messages/handler.ts` is the core dispatch logic:

1. Rate limit check
2. Parse Anthropic payload
3. Detect subagent marker (`__SUBAGENT_MARKER__` in `<system-reminder>`) → sets `x-initiator: agent`
4. Detect compact requests (Claude Code context compaction)
5. Force `smallModel` for tool-less warmup/probe requests
6. Merge mixed `tool_result` + text blocks to avoid fresh premium request
7. Normalize model ID → look up Copilot model
8. Route to one of three upstream flows:
   - `handleWithMessagesApi` — Copilot native `/v1/messages` (Claude models, preferred)
   - `handleWithResponsesApi` — Copilot `/responses` (GPT models)
   - `handleWithChatCompletions` — fallback for everything else

### Key directories

| Path | Purpose |
|---|---|
| `src/server.ts` | Hono app, middleware stack, route registration |
| `src/lib/` | Shared utilities: config, state, auth, tokens, rate-limit, models, tokenizer, trace |
| `src/routes/` | Route handlers grouped by endpoint family |
| `src/services/` | Upstream API clients (Copilot, GitHub, providers) |
| `tests/` | All test files (`*.test.ts`), Bun built-in runner |

### Middleware stack (in order)

`traceIdMiddleware` → `logger()` → `cors()` → `createAuthMiddleware` (API key validation via `x-api-key` or `Authorization: Bearer`; unauthenticated paths: `/`, `/usage-viewer`)

### Model routing

`src/lib/models.ts` normalizes Claude model IDs via 5 regex patterns (handles variants like `claude-opus-4-6`, `claude-opus-4.6`). The `useMessagesApi` config flag (default `true`) controls whether Claude-family models use the native Messages API or fall back to Chat Completions.

### Config and state

- `src/lib/config.ts` — `AppConfig` shape, disk read/write from `~/.local/share/copilot-api/config.json` (Linux/macOS) or `%USERPROFILE%\.local\share\copilot-api\config.json` (Windows). Also respects `COPILOT_API_HOME` env var.
- `src/lib/state.ts` — singleton mutable state: tokens, accountType, rate-limit, models cache.

### Token counting

`/v1/messages/count_tokens`: when `anthropicApiKey` is configured, forwards Claude model requests to Anthropic's free `/v1/messages/count_tokens` endpoint for exact counts. Otherwise falls back to GPT `o200k_base` tokenizer with 1.15x multiplier (`src/lib/tokenizer.ts`).

### Token usage storage

Token usage events are persisted through an async DB abstraction (`src/lib/sqlite.ts`, `AsyncDatabase`) with two interchangeable backends, consumed only by `src/lib/token-usage/store.ts`:

- **Local SQLite** (default) — `bun:sqlite` or `node:sqlite` (Node >= 22.13.0), wrapped as async.
- **Turso / libsql** (remote) — `src/lib/turso.ts`, dynamically imports `@libsql/client/web` (pure fetch, no native bindings). `intMode: "number"` is mandatory so INTEGER columns never come back as BigInt.

`getDatabaseConfig()` in `src/lib/config.ts` resolves the backend from a single connection string; the type is **inferred from its scheme** (`libsql://`, `ws(s)://`, `http(s)://` → turso; otherwise local sqlite), so there is no explicit type flag. Resolution precedence:

1. Env: `COPILOT_API_DATABASE_URL` → `COPILOT_API_SQLITE_DB_PATH` (legacy alias).
2. `config.json` `database` block — `{ url?, authToken? }`. `url` is the connection string (a libsql URL or a local path); `authToken` is the Turso token.
3. Default: local sqlite at `<APP_DIR>/copilot-api.sqlite`.

Turso auth token: `TURSO_AUTH_TOKEN` → `database.authToken`. SQLite-only PRAGMAs (`journal_mode=WAL`, `busy_timeout`, `wal_checkpoint`) are gated on `db.kind === "sqlite"`.


## Code Style

- **Imports:** Use `~/` alias for `src/` (e.g., `import { foo } from '~/lib/foo'`)
- **TypeScript:** Strict mode — no `any`, `noUnusedLocals`, `noUnusedParameters`
- **Modules:** ESNext only, no CommonJS
- **Naming:** `camelCase` for functions/variables, `PascalCase` for types/interfaces
- **Error handling:** Route handlers catch and call `forwardError(c, error)`; use `HTTPError` from `src/lib/error.ts`
- **Streaming:** All three API flows support both streaming (SSE via `streamSSE`) and non-streaming, switching on `payload.stream`

## Plugin Integrations

- **Claude Code agent-inject plugin:** Install from marketplace with `/plugin marketplace add https://github.com/caozhiyuan/copilot-api.git` then `/plugin install agent-inject@copilot-api-marketplace`. Injects `__SUBAGENT_MARKER__` on subagent starts.
- **Claude Code tool-search plugin:** Install from the same marketplace with `/plugin install tool-search@copilot-api-marketplace`. Registers the `tool_search` MCP bridge.
- **Opencode plugin:** Copy `plugin/opencode/subagent-marker.js` to `~/.config/opencode/plugins/`.
