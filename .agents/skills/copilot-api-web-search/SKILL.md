---
name: copilot-api-web-search
description: Run grounded web searches, open and inspect web pages, find patterns within pages, follow page links, and query structured data (finance, weather, sports, time) through a running copilot-api gateway (/v1/alpha/search and /:provider/v1/alpha/search) using GITHUB_COPILOT_API_KEY and COPILOT_API_BASE_URL. Use when the user wants live web search, page reading, multi-turn search/open/find sessions, or alpha search via copilot-api (also triggers on web search, alpha search). Do not use for reading local files, inspecting git history, or calling non-search model APIs.
---

# Copilot API Web Search Skill

Run structured, session-aware web search and page inspection through a running `copilot-api` gateway (`/v1/alpha/search`) via the bundled zero-dependency Node.js/Bun CLI (`scripts/web_search.mjs`).

## When to use

- Run one or more web searches and retrieve grounded snippets with `ref_id` citations
- Open a URL or a previously returned `ref_id` to inspect page content
- Find a specific text pattern inside an opened page or URL
- Follow a numbered link (`click`) from an opened page snapshot
- Query structured lookups: `finance`, `weather`, `sports`, or `time`
- Run combined multi-command alpha-search requests in a single turn (`raw`)

## When not to use

- Searching local repository code or reading local files (use local file/search tools)
- Inspecting GitHub PRs/issues when `gh` or a dedicated GitHub integration is better suited
- Tasks that require authenticated private intranet sites the upstream search backend cannot reach

## Quick start

Resolve `<SKILL_DIR>` relative to this `SKILL.md` (in this repository: `.agents/skills/copilot-api-web-search`):

```bash
export WEB_SEARCH=".agents/skills/copilot-api-web-search/scripts/web_search.mjs"
```

Run with `node` (Node.js 20+) or `bun` — no `npm install` or Python packages required:

```bash
node "$WEB_SEARCH" search --query "copilot-api web search" --response-length medium
```

## Decision tree

1. **Need web discovery?** Start with `search --query "<q>"` (repeatable for multiple queries).
2. **Need to read a returned result?** Reuse the printed `Session ID` with `open --session-id <id> --ref turn0search0` (or open any direct `https://...` URL).
3. **Need a specific passage on a page?** Reuse `--session-id` with `find --ref turn0view0 --pattern "<term>"`.
4. **Need to follow a link from an opened snapshot?** Reuse `--session-id` with `click --ref turn0view0 --link-id <n>`.
5. **Need finance / weather / sports / time?** Use `structured` with the matching flags.
6. **Need multiple command types in one turn?** Use `raw --commands-json '...'` or `--commands-file <path>`.

## Workflow

1. Check whether `COPILOT_API_BASE_URL` (default `http://localhost:4141`) and `GITHUB_COPILOT_API_KEY` are configured when targeting a protected or non-loopback gateway.
2. For complex or multi-command queries, optionally preview with `--dry-run` first.
3. Run `search` (or `open` / `structured`) with crisp, focused queries. Prefer `--response-length short` for quick lookups and `medium`/`long` for research.
4. Capture the returned `Session ID` whenever you plan follow-up `open`, `find`, or `click` calls — `ref_id` references (`turn0search0`, `turn0view0`) are scoped to the session `id`.
5. Use `--format json` when you need machine-readable `results[]` (`ref_id`, `title`, `url`, `snippet`, `domain`) or want to inspect raw provider fields.
6. Report grounded findings with the cited URLs and distinguish verified search results from any warnings returned by the gateway (for example, `image_query` or `screenshot` warnings on the GitHub Copilot Responses fallback).

## Provider routing & defaults

`copilot-api` routes `POST /v1/alpha/search` according to gateway configuration:

- **Codex priority (default):** When `alphaSearchCodexPriority` is enabled and `codex` is configured, top-level requests prefer native Codex Alpha Search; non-`gpt*` model names default to `gpt-6-luna`.
- **Explicit provider targeting:** Pass `--model codex/<model>`, `--model deepseek/<model>`, or `--provider <name>` (calls `/:provider/v1/alpha/search`). Official DeepSeek providers use native DeepSeek Alpha Search.
- **Responses web-search fallback:** When Codex is unavailable and the target is not native DeepSeek, the gateway fulfills `search_query`, `open`, `click`, `find`, `finance`, `weather`, `sports`, and `time` via Responses `web_search` (redirecting Messages-backed models to `alphaSearchModel`, default `gpt-6-luna`).

Default CLI model is `gpt-6-luna`. Override with `--model` or `--provider` when you need a specific backend.

## Environment & security

- `GITHUB_COPILOT_API_KEY`: gateway API key sent as `Authorization: Bearer <key>`. Matches `copilot-api`'s shared client key variable used across Codex, OpenCode, and DeepSeek Harness.
  - Optional only when calling a local loopback gateway (`localhost`, `127.0.0.1`, `::1`) without `auth.apiKeyConfigs`.
  - Required for non-loopback gateways and for any gateway with `auth.apiKeyConfigs` configured.
- `COPILOT_API_BASE_URL`: optional gateway root URL (default `http://localhost:4141`).
- Never ask the user to paste their full API key into chat, never echo `GITHUB_COPILOT_API_KEY`, and never pass keys via CLI flags.

If authentication fails (HTTP 401/403) or the key is missing for a remote gateway, instruct the user to set `GITHUB_COPILOT_API_KEY` locally in their shell environment and confirm when ready.

## Guardrails

- Use `scripts/web_search.mjs` directly; do not write one-off curl/fetch wrapper scripts unless the user asks for one.
- Keep session IDs consistent across multi-turn `search` -> `open` -> `find`/`click` workflows.
- When saving output with `--out`, the script refuses to overwrite an existing file unless `--force` is passed.

## Reference map

- `references/cli.md`: subcommands, flags, and multi-turn CLI recipes.
- `references/api.md`: `copilot-api` `/v1/alpha/search` routing, request schema, fallback limits, and billing notes.
- `scripts/web_search.mjs`: standalone zero-dependency Node.js/Bun CLI.
