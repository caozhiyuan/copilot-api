# Repository Guidelines

## Project Structure & Module Organization

This is a Bun/TypeScript API gateway project. Core server and route code lives in `src/`, with shared utilities under `src/lib/`, API protocol contract types (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages) under `src/lib/types/`, provider integrations under `src/services/`, and HTTP routes under `src/routes/`. Tests are in `tests/` and follow the same feature names as the source modules they cover. Static web assets are in `pages/`; documentation and screenshots are in `docs/`. The Electron desktop app is isolated under `desktop/` with its own source, assets, and package files. Plugin scripts live in `plugin/` and are excluded from the root ESLint config.

## Build, Test, and Development Commands

- `bun run dev`: run the API in watch mode with system CA enabled.
- `bun run start`: run the production entrypoint locally.
- `bun run build`: build the package with `tsdown`.
- `bun run build:desktop`: build the desktop server bundle.
- `bun run typecheck`: run TypeScript checks with `noEmit`.
- `bun run lint` or `bun run lint:all`: run ESLint and Prettier checks.
- `bun test`: run all Bun tests.
- `bun test tests/provider-resolver.test.ts`: run one test file.

## Coding Style & Naming Conventions

Use ES modules and strict TypeScript. Prefer `~/*` imports for files under `src/`. Use `camelCase` for variables and functions, `PascalCase` for types/classes, and descriptive filenames such as `responses-stream-translation.ts`. Avoid `any`; model request, response, entity, and DTO fields from the actual source types. Formatting is enforced by ESLint plus Prettier, with semicolons disabled.

Run `bun run lint --fix <files>` to format changed files with the repository's ESLint/Prettier configuration. Do not run standalone `prettier` or `bunx prettier`; they may ignore the inline repository options (including `semi: false`) and rewrite entire files with the wrong style.

## Testing Guidelines

Use Bun's built-in test runner. Add or update tests in `tests/` with `*.test.ts` names. When code changes are made, changed code must reach at least 85% unit test coverage. Cover request translation, provider behavior, auth, config, and streaming edge cases near the modified code.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit prefixes such as `feat:` and `chore:`. Keep commit subjects short and imperative, for example `feat: support custom provider auth flow`. Pull requests should include a clear summary, linked issues when applicable, test evidence (`bun test`, targeted tests, lint/typecheck), and screenshots for desktop or UI changes.

## Security & Configuration Tips

Do not commit tokens, local credentials, or generated secrets. Review auth, proxy, TLS, and token refresh changes carefully, especially files under `src/lib/`, `src/auth.ts`, and `src/services/github/`. Model admission is centralized in `src/lib/model-admission.ts`; enforce it after mappings and provider aliases resolve and use it for every exposed model catalog.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
