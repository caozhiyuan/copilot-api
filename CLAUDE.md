# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Background

This is a reverse-engineered proxy for the GitHub Copilot API that exposes it as OpenAI and Anthropic compatible endpoints. Fork of `ericc-ch/copilot-api`, maintained at [nick3/copilot-api](https://github.com/nick3/copilot-api).

**Workflow**: All PRs target the `all` branch (not `master` or `main`).

## Build, Lint, and Test Commands

```bash
bun run build          # Build with tsdown + admin-ui
bun run dev            # Dev mode with watch
bun run lint           # Lint (excludes admin-ui)
bun run lint --fix     # Auto-fix lint issues
bun test               # Run all tests
bun test tests/foo.test.ts  # Run single test file
bun run start          # Production mode
bun run typecheck      # TypeScript check
```

Admin UI (separate workspace in `admin-ui/`):
```bash
bun run dev:admin      # Dev server for admin UI
bun run build:admin    # Build admin UI only
bun run lint:admin     # Lint admin UI
```

## Code Style

- **Imports**: Use `~/*` path alias for `src/*` (configured in tsconfig.json)
- **Modules**: ESNext only, no CommonJS
- **Types**: Strict TypeScript, avoid `any`
- **Naming**: `camelCase` for variables/functions, `PascalCase` for types/classes
- **Errors**: Use explicit error classes from `src/lib/error.ts`
- **Testing**: Bun test runner, files in `tests/` named `*.test.ts`

## Architecture Overview

### Entry Points

- `src/main.ts` - CLI entry using `citty` with subcommands: `start`, `auth`, `check-usage`, `debug`
- `src/start.ts` - Server initialization, account setup, auth flow orchestration
- `src/server.ts` - Hono HTTP server setup with middleware and route registration

### Request Flow

```
Client Request → Route Handler → Rate Limit Check → Account Selection →
Request Translation (if needed) → Copilot Service → Response Translation → Client
```

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
- `messages/` - Anthropic-style `/v1/messages` with translation layer
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

### Data Persistence

All stored in `~/.local/share/copilot-api/`:
- `registry.json` - Account metadata
- `accounts/<id>/` - GitHub and Copilot tokens per account
- `admin.sqlite` - Request history (14-day retention, 200k row cap)
- `config.json` - Application configuration

### Account Selection Logic

- **Premium models**: Accounts tried in order; switches on quota exhaustion
- **Free models**: Round-robin across accounts (configurable via `freeModelLoadBalancing`)
- Quota reservation system prevents overspend during concurrent requests

## Claude Code Integration Notes

When used with Claude Code via `--claude-code` flag or `.claude/settings.json`:
- Use `AskUserQuestion` tool for user interaction (do not ask questions directly)
- Use `AskUserQuestion` to confirm task completion so user can provide feedback
