# AGENTS.md

## Project Background

This project is a reverse-engineered proxy for the GitHub Copilot API that exposes OpenAI-compatible and Anthropic-compatible endpoints.

It is a fork of `caozhiyuan/copilot-api`, created because the original repository appears to be unmaintained.

- **Current Repository**: [nick3/copilot-api](https://github.com/nick3/copilot-api)
- **Workflow**:
  - All pushes and Pull Requests should be directed to `nick3/copilot-api`，not `caozhiyuan/copilot-api`.
  - The default active branch is `all` (not `master` or `main`).
  - All Pull Requests should target the `all` branch.

## Build, Lint, and Test Commands

- **Build:**  
  `bun run build` (uses `tsdown` and builds `admin-ui`)
- **Build admin only:**  
  `bun run build:admin`
- **Dev:**  
  `bun run dev`
- **Dev admin:**  
  `bun run dev:admin`
- **Lint:**  
  `bun run lint` (root project, excludes `admin-ui`, uses `@echristian/eslint-config`)
- **Lint admin:**  
  `bun run lint:admin`
- **Lint & Fix staged files:**  
  `bunx lint-staged`
- **Test all:**  
  `bun test`
- **Test single file:**  
  `bun test tests/accounts-manager-reservation.test.ts`
- **Typecheck:**  
  `bun run typecheck`
- **Start (prod):**  
  `bun run start`

## Code Style Guidelines

- **Imports:**  
  Use ESNext syntax. Prefer absolute imports via `~/*` for `src/*` (see `tsconfig.json`).
- **Formatting:**  
  Follows Prettier (with `prettier-plugin-packagejson`). Run `bun run lint` to auto-fix.
- **Types:**  
  Strict TypeScript (`strict: true`). Avoid `any`; use explicit types and interfaces.
- **Naming:**  
  Use `camelCase` for variables/functions, `PascalCase` for types/classes.
- **Error Handling:**  
  Use explicit error classes (see `src/lib/error.ts`). Avoid silent failures.
- **Unused:**  
  Unused imports/variables are errors (`noUnusedLocals`, `noUnusedParameters`).
- **Switches:**  
  No fallthrough in switch statements.
- **Modules:**  
  Use ESNext modules, no CommonJS.
- **Testing:**  
   Use Bun's built-in test runner. Place tests in `tests/`, name as `*.test.ts`.
- **Linting:**  
  Uses `@echristian/eslint-config` (see npm for details). Includes stylistic, unused imports, regex, and package.json rules.
- **Paths:**  
  Use path aliases (`~/*`) for imports from `src/`.

## Architecture Overview

### Entry Points

- `src/main.ts` - CLI entry using `citty` with subcommands: `start`, `auth`, `check-usage`, `debug`
- `src/start.ts` - Server initialization, account setup, auth flow orchestration
- `src/server.ts` - Hono HTTP server setup with middleware and route registration

### Middleware Stack

- `traceIdMiddleware` → `logger()` → `cors()` → `createAuthMiddleware`
- Unauthenticated path prefixes include `/admin` and `/api/admin`; request auth for API clients is handled via `x-api-key` or `Authorization: Bearer`

### Request Flow

```text
Client Request → Route Handler → Rate Limit Check → Account Selection →
Request Translation (if needed) → Copilot Service → Response Translation → Client
```

### `/v1/messages` Flow

`src/routes/messages/handler.ts` is the actual Anthropic entrypoint. Treat it as the source of truth over older helper layouts.

1. Check rate limits and parse the Anthropic payload.
2. Detect subagent markers and root session IDs to preserve initiator/session semantics.
3. Detect Claude Code warmup probes and compact requests; optionally switch warmup or compact traffic to `smallModel`.
4. For non-compact requests, run `stripToolReferenceTurnBoundary()` before `mergeToolResultForClaude()` so Claude Code tool-search continuations do not become fresh premium turns.
5. Validate alias-only model access, normalize the requested model, and build candidate upstream endpoints.
6. Select an account via `accountsManager.selectAccountForRequest()` with quota reservation and optional affinity.
7. Route to Copilot `/v1/messages`, `/responses`, or `/chat/completions` based on the selection result, then translate the response back to Anthropic semantics.
8. Record request history, usage, affinity hit/miss, latency, and errors in `admin.sqlite`.

### Key Directories

**`src/lib/`** - Core business logic:
- `accounts-manager.ts` - Multi-account management, quota tracking, token lifecycle
- `accounts-manager-auth.ts` - Token refresh and state management
- `accounts-manager-quota.ts` - Premium quota reservation system
- `accounts-registry.ts` - Account persistence layer
- `api-config.ts` - Copilot API headers and URL configuration
- `request-history.ts` - SQLite-backed request logging
- `config.ts` - Application config from `~/.local/share/copilot-api/config.json`
- `state.ts` - Global runtime state (tokens, models, rate limits)
- `error.ts` - `HTTPError` class and `forwardError()` handler wrapper

**`src/routes/`** - HTTP handlers:
- `chat-completions/` - OpenAI-style `/v1/chat/completions`
- `messages/` - Anthropic-style `/v1/messages`, request orchestration, token counting, and translation layer
- `responses/` - Copilot native `/v1/responses`
- `embeddings/`, `models/`, `token/`, `usage/` - Supporting endpoints
- `admin/`, `admin-api/` - Admin UI and API

**`src/services/`** - External API integrations:
- `copilot/` - Copilot API clients (chat-completions, messages, responses, embeddings, models)
- `github/` - GitHub auth services (device code flow, token polling, user info)

### Translation Layer

The `/v1/messages` endpoint translates between Anthropic and OpenAI formats:
- `messages/non-stream-translation.ts` - `translateToOpenAI()` and `translateToAnthropic()`
- `messages/stream-translation.ts` - Streaming event conversion
- `messages/responses-translation.ts` - Responses ↔ Anthropic conversion

### Messages-Specific Notes

- `src/routes/messages/route.ts` exposes both `/v1/messages` and `/v1/messages/count_tokens`.
- `src/services/copilot/create-messages.ts` accepts `createMessages(payload, account?, options?)`; prefer passing `AccountContext` from account selection instead of assuming global single-account state.
- `src/routes/messages/preprocess.ts` contains the compact/tool-result normalization logic; changes here usually require updates to `tests/messages-preprocess.test.ts`.
- `src/routes/messages/api-flows.ts` still exists, but the current branch’s orchestration logic lives in `handler.ts`.

### Data Persistence

All stored in `~/.local/share/copilot-api/`:
- `registry.json` - Account metadata
- `accounts/<id>/` - GitHub and Copilot tokens per account
- `admin.sqlite` - Request history (14-day retention, 200k row cap)
- `config.json` - Application configuration

### Account Selection Logic

- **Premium models**: Accounts tried in order; switches on quota exhaustion
- **Free models**: Round-robin across accounts on initial distribution (configurable via `accountAffinity`); with affinity enabled, subsequent requests from the same session stick to the previously successful account
- Quota reservation system prevents overspend during concurrent requests

### Token Counting

- `/v1/messages/count_tokens` forwards Claude requests to Anthropic when `anthropicApiKey` is configured.
- Otherwise it falls back to GPT `o200k_base` estimation with the project’s compatibility multiplier.

## Agent Notes

- When working on `/v1/messages`, verify behavior in `tests/messages-handler.test.ts`, `tests/messages-preprocess.test.ts`, `tests/create-messages.test.ts`, and `tests/warmup-probe.test.ts`.
- Preserve the current multi-account, request-history, and admin UI architecture when merging upstream changes; do not collapse the codepath back to the earlier single-account flow.
- Subagent semantics depend on `__SUBAGENT_MARKER__` propagation from Claude Code or opencode plugins; changes to marker parsing should be validated against the message handler flow.

---

This file is tailored for agentic coding agents. For more details, see the configs in `eslint.config.js` and `tsconfig.json`. No Cursor or Copilot rules detected.
