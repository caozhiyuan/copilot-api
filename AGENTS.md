# Repository Guidelines

## Project Layout

- `src/`: Bun/TypeScript API gateway; `routes/` handles HTTP endpoints, `services/` integrates providers, `lib/` holds shared logic, and `lib/types/` defines OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages contracts.
- `tests/`: gateway tests named after the features they cover; `pages/`: static web assets; `docs/`: documentation and screenshots; `plugin/`: plugin scripts.
- `desktop/`: Electron app with its own package, source, and checks; root ESLint excludes both `desktop/` and `plugin/`.

## Commands

Run from the repository root unless noted:

- `bun run dev` / `bun run start`: watch / production API entrypoint, with system CA enabled.
- `bun run build`: package build; `bun run build:desktop`: desktop server bundle.
- `bun run typecheck` / `bun run lint`: gateway TypeScript / ESLint checks.
- `bun run typecheck:all` / `bun run lint:all`: gateway and desktop checks.
- `bun test tests/provider-resolver.test.ts`: one test file; use explicit `tests` and/or `desktop/tests` directories for larger suites, and capture their output as described below.
- `bun run --cwd desktop test`: desktop tests; `bun run --cwd desktop build`: Electron app build.

## Code Style

- Use ES modules, strict TypeScript, and `~/*` imports within `src/`; avoid `any` and derive request/response fields from actual contract types.
- Use `camelCase` for variables/functions, `PascalCase` for types/classes, and descriptive filenames such as `responses-stream-translation.ts`.
- Format gateway files with `bun run lint --fix <files>`; use the desktop package's lint configuration for desktop files.
- ESLint embeds Prettier options, including `semi: false`; do not run standalone `prettier` or `bunx prettier`.

## Minimal Change Principle

When adding new features or modifying existing ones, make only the changes necessary to meet the current requirements.

## Verification

- Use Bun tests named `*.test.ts` in `tests/` or `desktop/tests/`, matching the affected package.
- Never run bare `bun test` or stream unfiltered test-suite output into the conversation. Always specify test files/directories and redirect stdout and stderr to a temporary log file; inspect and report only the result summary, relevant failures, and changed-code coverage.
- Changed code must reach at least 80% unit test coverage; use `bun test --coverage <test-files>` to inspect coverage.
- Test affected request translation, providers, auth, config, and streaming edge cases; run the relevant tests, lint, and typecheck for code changes, expanding validation for shared behavior.
- For documentation-only changes, verify referenced paths/commands and inspect the diff; application tests are unnecessary.

## Security

Never commit tokens, local credentials, or generated secrets; carefully check auth, proxy, TLS, and token refresh changes, especially in `src/lib/`, `src/auth.ts`, and `src/services/github/`.

## Commits and Pull Requests

Use short, imperative Conventional Commit subjects such as `feat: support custom provider auth flow`; PRs should describe the resulting behavior, link relevant issues, list checks and results, and include screenshots for desktop/UI changes.
