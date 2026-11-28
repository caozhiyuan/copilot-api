---
name: copilot-api-code-review
description: Code review guidelines for the copilot-api Bun/TypeScript API gateway. Use when reviewing code changes, pull requests, or uncommitted work in this repository. Defines the review workflow, evidence standards, severity levels, a project-specific checklist (protocol translation, streaming, auth/credentials, proxy/TLS, config/state), verification commands, and the structured CODE_REVIEW_SUMMARY output format. All review output is written in English.
---

# copilot-api Code Review Guidelines

This skill is the project-specific code review standard for the copilot-api repository (a Bun/TypeScript API gateway providing OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages compatibility over GitHub Copilot and third-party providers).

MUST NOT review using only `git diff`. Always combine the diff with surrounding code, related tests, configs, and project context.

## Goal

Ship changes that are correct, safe, maintainable, and releasable with minimal overhead.

## Scope

This document defines the review workflow, review standard, verification commands, and output format for this repository.

## Anti-Hallucination Standard

Treat review findings as evidence-backed claims, not guesses.

- A finding must be based on inspected repository evidence: changed code, nearby implementation, callers/callees, tests, configs, schema, docs, or explicitly checked dependency behavior.
- Do not claim a file, symbol, test, config, command result, or dependency behavior was checked unless it was actually inspected or run.
- Do not turn missing context into a finding. Record missing context in `Context Checked`, `Test Notes`, or `Release Risk` as a limitation.
- Verified findings must include all four parts: evidence, impact path, affected scenario, and concrete fix.
- If evidence is plausible but incomplete, report it as an unverified risk or open question outside the counted findings.
- It is acceptable to return zero findings. Never create a finding just to have something to report.

## Required Context

Before judging a change, gather the minimum relevant context:

- Current change set: `git status`, `git --no-pager diff`, `git --no-pager diff --cached`, and recent commits when needed.
- Local code context: changed files plus nearby callers, callees, tests, config, schema, and related modules.
- Project docs: `AGENTS.md`, `README.md`, `docs/`, and `package.json` scripts.
- Protocol contract types under `src/lib/types/` (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages) whenever a change touches request/response translation; verify every claimed field against these types instead of assuming it exists.

If a context file does not exist, continue. Missing optional docs should not block the review.

Minimum context protocol:

- Read the relevant full function, class, or module around every changed hunk before judging it.
- Search for changed public symbols, exported APIs, commands, config keys, schemas, and routes to find callers and dependents.
- Read related tests under `tests/` before claiming behavior is untested; if tests were not inspected, say so instead of reporting a missing-test finding.
- Read related configuration, schema, migration, or API docs before claiming compatibility or release risk.
- If a command fails or a file cannot be read, record the limitation and avoid conclusions that depend on that missing context.

## Evidence Standard for Findings

Every counted finding must be reproducible from the checked context.

- `location` must point to the exact file and line that anchors the issue. For multi-location issues, cite the clearest anchor and describe the occurrence count only when it was verified.
- `reason` must connect evidence to impact: what the code does, why that behavior is risky, and which scenario exposes it.
- `fix` must be a concrete action that would address the verified issue.
- Do not rely on general best practices alone. A style preference, refactor idea, or speculative edge case belongs in `SUGGESTION` or outside counted findings.
- Do not assert runtime behavior of third-party libraries, frameworks, CLIs, upstream provider APIs (GitHub Copilot, OpenAI, Anthropic, etc.), or services unless it was verified from installed code, official docs, tests, or existing project usage.

## Uncertainty Handling

Separate verified issues from uncertainty.

- **Verified issue**: supported by inspected evidence and eligible for `CRITICAL`, `HIGH_PRIORITY`, or `SUGGESTION`.
- **Unverified risk**: plausible but not proven from available context; mention in `Test Notes` or `Release Risk`, not in counted findings.
- **Open question**: required context is missing or ambiguous; mention briefly outside counted findings.

Use cautious language for uncertainty. Do not write that something "will" fail, is "missing", or is "unused" unless the checked evidence supports that claim.

## Severity Levels

- **CRITICAL (must fix)**: can cause outages, token/credential leakage, data loss, security issues, broken core flows (auth, provider resolution, request translation, streaming), or release blockers.
- **HIGH_PRIORITY (should fix)**: likely bugs, footguns, hard-to-maintain design, missing key tests, or noticeable risk.
- **SUGGESTION (non-blocking)**: improvements, refactors, readability, minor perf issues, style alignment, or low-risk follow-up notes.

Severity must follow verified impact, not reviewer confidence or preference. Do not escalate a finding to `CRITICAL` or `HIGH_PRIORITY` unless the checked evidence shows a concrete failure mode, compatibility break, security/privacy risk, data-safety risk, or release-blocking test gap.

## Checklist - Must (Blocking)

1. **Correctness**
   - Meets requirements; no obvious logic gaps.
   - Edge cases and failure paths handled (null/empty, retries, timeouts, partial failures).
2. **Protocol & Translation Fidelity**
   - Translation between OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages matches the contract types under `src/lib/types/`; no invented or mistyped fields.
   - Request/response/entity/DTO fields are modeled from the actual source types; no `any`, no guessed optional fields.
   - Both directions of a translation change are checked (request in, response out), including non-stream vs stream parity.
3. **Streaming & Realtime**
   - SSE and websocket paths (`src/services/responses-websocket*.ts`, `fetch-event-stream` usage) keep correct event ordering, emit completion/termination events, propagate mid-stream errors, and handle client abort/cancellation without leaked or unterminated streams.
   - Rate-limit and token-usage accounting (`src/lib/copilot-rate-limit.ts`, `src/lib/codex-rate-limit.ts`, `src/lib/token-usage/`) stays correct when a stream aborts partway.
4. **Auth, Credentials & Tokens**
   - Changes touching `src/auth.ts`, `src/lib/oauth/`, `src/lib/credential-store.ts`, `src/lib/token.ts`, or `src/services/github/` get extra scrutiny: token refresh, expiry, redaction, atomic persistence.
   - No tokens, secrets, or PII in logs, error messages, telemetry, client code, or committed config.
5. **Proxy, TLS & Networking**
   - Proxy/TLS behavior (`src/lib/proxy.ts`, `src/lib/tls.ts`, `NODE_USE_SYSTEM_CA`, `src/lib/electron-fetch.ts`) does not break corporate proxy or system-CA setups.
   - Request timeouts and cancellation go through the established dispatcher (`src/lib/timeout-dispatcher.ts`) instead of ad-hoc timers where applicable.
6. **Config & State Compatibility**
   - Config store and SQLite schema changes (`src/lib/config-store.ts`, `src/lib/config.ts`, `src/lib/sqlite.ts`, `src/lib/atomic-file.ts`) are backward compatible or migrate safely; defaults are safe for existing installs.
   - Public route and API contract changes under `src/routes/` are backward compatible or carry an explicit migration note.
7. **Reliability**
   - No obvious races, resource leaks, unbounded loops, or brittle dependencies.
   - Proper error handling; meaningful errors for callers that match existing route error patterns.
8. **Maintainability & Project Conventions**
   - ES modules and strict TypeScript; `~/*` imports for files under `src/`; camelCase variables/functions, PascalCase types/classes, descriptive filenames.
   - Formatting follows the repo ESLint/Prettier setup (semicolons disabled); changed files were formatted with `bun run lint --fix <files>`, never standalone `prettier`/`bunx prettier`.
   - Clear naming; single-responsibility functions; complex logic explained or decomposed; respects the existing `src/lib` vs `src/services` vs `src/routes` boundaries.
9. **Tests**
   - Bun's built-in test runner is used; tests live in `tests/` as `*.test.ts` mirroring the source feature names.
   - Changed code reaches at least 80% unit test coverage near the modification; request translation, provider behavior, auth, config, and streaming edge cases are covered.
   - Tests are deterministic; no flaky timing or network assumptions.
10. **Cross-Surface Impact**
    - The Electron desktop app under `desktop/` is isolated with its own package files; shared changes must not break `bun run build:desktop` or the desktop typecheck.
    - `plugin/` scripts are excluded from the root ESLint config and `pages/` holds static assets; do not apply root src assumptions to them.
11. **Observability**
    - Useful logs for critical behavior via the existing logger (`src/lib/logger.ts`); logs are actionable, not noisy, and contain no sensitive data.

## Checklist - Nice to Have (Non-blocking)

- **Performance**: avoid obvious repeated I/O, unnecessary re-parsing/tokenization, or unbounded buffering of streams; consider caching or batching.
- **Consistency**: matches existing patterns in neighboring modules.
- **Dependencies**: avoid adding heavy or unvetted dependencies to `package.json`; check version, security, and license implications.
- **Documentation**: update `README.md`, `README.zh-CN.md`, `docs/`, or comments when behavior or usage changes.

## Verification Commands

Run the commands that match the scope of the change and record results in `Test Notes`:

- `bun run lint:all` (or `bun run lint --fix <changed files>` to format).
- `bun run typecheck`.
- `bun test`, or `bun test tests/<file>.test.ts` for targeted runs.
- `bun run build`; add `bun run build:desktop` when shared or desktop code is touched.

CI (`.github/workflows/ci.yml`) runs lint:all, root and desktop typecheck, `bun test`, and `bun run build`; review conclusions should not contradict what CI would enforce.

## Review Summaries

Provide these short summaries so the review output can be consumed by automation, follow-up workflows, or pasted into a pull request:

- `CHANGESET_SUMMARY`: about what changed and why, within roughly 100 words.
- `CODE_REVIEW_SUMMARY`: output the exact structured block below instead of free-form prose.

`CODE_REVIEW_SUMMARY` format:

```text
Review Decision: BLOCKING | NON_BLOCKING
Findings Total: <N> (CRITICAL=<n1>, HIGH_PRIORITY=<n2>, SUGGESTION=<n3>)

[CRITICAL]
1. reason=<reason>; location=<file>:<line>; fix=<action>; occurrences=<count>

[HIGH_PRIORITY]
1. reason=<reason>; location=<file>:<line>; fix=<action>; occurrences=<count>

[SUGGESTION]
1. reason=<reason>; location=<file>:<line>; fix=<action>; occurrences=<count>
```

Formatting rules for this block:

- Always emit all three sections in this order: `CRITICAL`, `HIGH_PRIORITY`, `SUGGESTION`.
- If a section has no findings, write `None` on the next line.
- `Review Decision` is `BLOCKING` when `CRITICAL > 0` or `HIGH_PRIORITY > 0`; otherwise use `NON_BLOCKING`.
- `Findings Total` must equal the sum of `CRITICAL`, `HIGH_PRIORITY`, and `SUGGESTION`.
- Keep the structured field names unchanged. Put evidence inside `reason` and the exact anchor inside `location`; do not add new fields to the structured block.

Keep both summaries concise and avoid unnecessary special characters outside the required structured fields.

## Counting Rules

The counts must be carried in the `Findings Total` line inside `CODE_REVIEW_SUMMARY`, and must match the sections actually reported.

## Output Language

All review output is written in English, regardless of reviewer locale or timezone. The structured field names (`Review Decision`, `Findings Total`, `CRITICAL`, `HIGH_PRIORITY`, `SUGGESTION`, `reason`, `location`, `fix`, `occurrences`) must remain exactly as defined for automation compatibility.

## Reviewer Output Template

Use this structure and keep it short and specific:

- **Summary**: <what changed / intent>
- **Context Checked**: <files/docs/types consulted; mention key missing or unread context>
- **CHANGESET_SUMMARY**: <within ~100 words>
- **CODE_REVIEW_SUMMARY**: follow the format and rules defined in the "Review Summaries" section above. If a section has no findings, write `None`.
- **Test Notes**: <what you ran; what you inspected; what was not run or not inspected>
- **Release Risk**: <low/med/high> + <why; distinguish verified risk from uncertainty>

When the review targets a pull request, paste the full reviewer output into the PR body under the "Code Review" section required by `.github/PULL_REQUEST_TEMPLATE.md`.
