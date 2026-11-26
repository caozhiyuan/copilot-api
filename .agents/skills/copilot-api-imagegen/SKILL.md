---
name: copilot-api-imagegen
description: Generate and edit raster images (plus animated GIFs on Codex) through a running copilot-api gateway (/v1/images/generations, /v1/images/edits, and /:provider/v1/images/*) using GITHUB_COPILOT_API_KEY and COPILOT_API_BASE_URL. Use whenever the user wants a new bitmap visual (photos, illustrations, product shots, UI mockups, infographics, sprites, logos, transparent cutouts), reference-based edits, mask-guided edits, or concurrent JSONL batch generation via copilot-api (also triggers on imagegen, generate image, edit image). Do not use when editing existing repo-native SVG/vector assets or building graphics directly in HTML/CSS/canvas.
---

# Copilot API Image Generation & Editing Skill

Generate and edit raster images through a running `copilot-api` gateway using the bundled zero-dependency Node.js/Bun CLI (`scripts/image_gen.mjs`).

No Python environment or `openai` SDK installation is required; the script runs directly on Node.js 20+ or Bun and works across all image providers supported by `copilot-api` (**Codex**, **GitHub Copilot**, **xAI**, and configured custom providers).

## When to use

- Generate a new raster image (concept art, product photo, hero banner, illustration, infographic, sprite, mockup)
- Generate an animated GIF (`--output-format gif`) via Codex `gpt-image-2`
- Edit an existing local image or image URL (inpainting, lighting/weather shifts, background replacement, object removal, compositing, style transfer, mask-guided edits)
- Produce multiple variants (`--n`) or many distinct assets concurrently (`generate-batch` JSONL)

## When not to use

- Extending or editing an existing SVG/vector icon set, logo system, or code-native asset inside the repo
- Creating simple diagrams, charts, or UI elements better authored in SVG, Mermaid, or HTML/CSS
- Pure image inspection/analysis without creating or modifying an image file

## Quick start

Resolve `<SKILL_DIR>` relative to this `SKILL.md` (in this repository: `.agents/skills/copilot-api-imagegen`):

```bash
export IMAGE_GEN=".agents/skills/copilot-api-imagegen/scripts/image_gen.mjs"
```

Dry-run first to inspect the resolved gateway URL, redacted auth status, default temp output path, and payload:

```bash
node "$IMAGE_GEN" generate \
  --prompt "A minimal hero image of a matte ceramic coffee mug on warm stone" \
  --size 1536x1024 \
  --dry-run
```

## Decision tree

Evaluate three questions before running:

1. **Intent (`generate` vs `edit`):**
   - Modifying an existing image while preserving parts of it -> **`edit`**
   - Creating a brand-new image (no input image) -> **`generate`**
   - Note: If the user supplies reference images for style/subject guidance, pass them via **`edit`** (`--image`, repeatable) and describe each image's role by index in the prompt.
2. **Execution strategy (single vs variants vs batch):**
   - One prompt, one output -> `generate` (or `edit`)
   - One prompt, multiple variations -> `--n 2..4`
   - Many distinct assets/prompts -> `generate-batch --input <temp-dir>/prompts.jsonl` (omit `--out-dir` to write to a unique directory under `<os.tmpdir()>/copilot-api-imagegen/`, or pass `--out-dir <path>` when saving into a target workspace directory; do not misuse `--n` for unrelated assets)
3. **Provider & model selection:**
   - Default (`--model gpt-image-2` or `--auto-model`): `copilot-api` applies `modelMappings` first, then automatically picks the first available provider in order:
     1. **Codex** (`gpt-image-2`)
     2. **GitHub Copilot** (`gpt-image-2.5-flare`)
     3. **xAI** (`grok-imagine-image-2.0`)
   - Explicit provider/model pinning: pass `--model codex/gpt-image-2`, `--model codex/gpt-image-1.5`, `--model github-copilot/gpt-image-2.5-flare`, `--model xai/grok-imagine-image-2.0`, or `--provider <name>`.

## Workflow

1. Determine intent (`generate` vs `edit`), strategy (single vs `generate-batch`), and target provider/model.
2. Collect inputs up front: prompt, exact verbatim text (if any), invariants/avoid list, optional destination path (only if the user asked to save into the workspace), and input image paths/URLs with explicit per-image roles (`Image 1: base to edit; Image 2: style reference`).
3. Shape the prompt using the specificity policy below (normalize detailed prompts without inventing extras; add tasteful concrete detail only when generic).
4. Run `node "$IMAGE_GEN" ...` (optionally `--dry-run` first for complex edits or batches).
5. Inspect the generated artifact (view it if an image-viewing tool is available) and check subject, framing, text accuracy, and invariants.
6. Iterate with single targeted changes (`edit` with explicit invariants) rather than rewriting everything at once.
7. Keep default outputs in the OS temporary directory (`<os.tmpdir()>/copilot-api-imagegen/`) unless the user requested a specific workspace path, remove temporary JSONL batch files when finished, and report the final saved path(s), prompt, and model/provider used.

## Prompt augmentation & specificity policy

Treat the labeled fields as prompt scaffolding, not a closed schema:

- **Detailed user prompt:** preserve the user's specifics; only normalize structure and clarity.
- **Generic user prompt:** add tasteful composition, lighting, or intended-use hints that materially improve output quality.
- **Never invent** unrequested characters, brand names, slogans, or story elements.
- **For edits:** explicitly state invariants (`change only X; keep Y unchanged`) and repeat them on follow-up iterations to prevent drift.

### Use-case taxonomy (slugs)

Generate: `photorealistic-natural`, `product-mockup`, `ui-mockup`, `infographic-diagram`, `scientific-educational`, `ads-marketing`, `productivity-visual`, `logo-brand`, `illustration-story`, `stylized-concept`, `historical-scene`.

Edit: `text-localization`, `identity-preserve`, `precise-object-edit`, `lighting-weather`, `background-extraction`, `style-transfer`, `compositing`, `sketch-to-render`.

### Shared prompt schema

```text
Use case: <taxonomy slug>
Primary request: <user's main prompt>
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo/illustration/3D/etc>
Composition/framing: <wide/close/top-down; placement>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep/must avoid>
Avoid: <negative constraints>
```

You can pass structured hints via CLI flags (`--use-case`, `--scene`, `--subject`, `--style`, `--composition`, `--lighting`, `--palette`, `--materials`, `--text`, `--constraints`, `--negative`) or write the complete prompt directly in `--prompt` / `--prompt-file`.

## Provider & model guidance

- **`gpt-image-2` (default / Codex):**
  - Sizes: `auto` or flexible `WIDTHxHEIGHT` (max edge `<= 3840px`, multiples of `16px`, ratio `<= 3:1`, pixels `655,360..8,294,400`). Popular sizes: `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840`.
  - Quality: `low` (fast drafts), `medium` (balanced default), `high`, `auto`.
  - Does **not** support `background=transparent` or `input_fidelity` (image inputs already use high fidelity).
  - Supports animated GIF generation (`--output-format gif --frame-count 9 --frame-duration-ms 200`).
- **`gpt-image-1.5` (explicit transparent cutout / `input_fidelity` fallback):**
  - Ask the user before switching from `gpt-image-2` to `gpt-image-1.5` unless they explicitly requested native transparency or `gpt-image-1.5`.
  - Supports `--background transparent --output-format png` (or `webp`) and `--input-fidelity low|high`.
  - Sizes: `1024x1024`, `1536x1024`, `1024x1536`, `auto`.
- **`github-copilot/gpt-image-2.5-flare`:**
  - OpenAI-compatible JSON/multipart generation & edits via GitHub Copilot; does not support GIF output.
- **`xai/grok-imagine-image-2.0`:**
  - `copilot-api` translates `size` into xAI `aspect_ratio` + `resolution` (`1k`/`2k`) and returns `b64_json` automatically.
  - Limits: max **5** edit images, **no `--mask`**, **no GIF**, **no streaming**.

## Temp & output conventions

- Default outputs for `generate`, `edit`, and `generate-batch` go to unique paths inside the OS temporary directory (`<os.tmpdir()>/copilot-api-imagegen/`) so the current project directory stays clean and consecutive runs do not collide.
- Store temporary JSONL batch files in the OS temporary directory (never inside the current repository) and delete them when finished.
- Pass `--out <path>` or `--out-dir <dir>` only when the user explicitly wants the generated asset(s) saved to a specific workspace path.
- Existing files are never overwritten unless `--force` is passed.

## Environment & security

- `GITHUB_COPILOT_API_KEY`: gateway API key sent as `Authorization: Bearer <key>` (the shared client key variable used across `copilot-api`).
  - Optional only for local loopback gateways (`localhost`, `127.0.0.1`, `::1`) with no `auth.apiKeyConfigs`.
  - Required for protected or non-loopback gateways.
- `COPILOT_API_BASE_URL`: optional gateway root URL (default `http://localhost:4141`).
- Never ask the user to paste the full key in chat, never log/echo the key, and never pass keys as CLI flags.

## Guardrails

- Run `scripts/image_gen.mjs` directly; do not write ad-hoc wrapper scripts unless asked.
- Do not silently downgrade `gpt-image-2` to `gpt-image-1.5` for transparency without confirming with the user.
- For edits, keep saves non-destructive (new output filename by default).

## Reference map

- `references/cli.md`: CLI subcommands, flags, multipart/JSON edit transport, GIFs, and batch JSONL examples.
- `references/image-api.md`: `copilot-api` multi-provider routing rules, size/format limits, and provider quirks.
- `references/prompting.md`: prompting principles, specificity rules, invariants, and iteration patterns.
- `references/sample-prompts.md`: copy/paste prompt recipes by taxonomy slug.
- `scripts/image_gen.mjs`: standalone zero-dependency Node.js/Bun CLI.
