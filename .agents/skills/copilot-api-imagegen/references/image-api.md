# Image API Reference (`copilot-api`)

## Endpoints

- Top-level:
  - `POST /v1/images/generations` (alias: `/images/generations`)
  - `POST /v1/images/edits` (alias: `/images/edits`)
- Provider-scoped:
  - `POST /:provider/v1/images/generations`
  - `POST /:provider/v1/images/edits`

Authentication uses `Authorization: Bearer $GITHUB_COPILOT_API_KEY`. Loopback gateways without `auth.apiKeyConfigs` allow unauthenticated requests; protected and non-loopback gateways require a valid gateway key.

## Gateway routing rules

1. **Model mappings first:** Top-level routes resolve `modelMappings` before provider selection.
2. **Automatic default selection:** Only an omitted/blank `model` or bare `gpt-image-2` triggers automatic fallback across enabled providers in order:
   1. `codex` -> `gpt-image-2`
   2. `github-copilot` -> `gpt-image-2.5-flare`
   3. `xai` -> `grok-imagine-image-2.0`
   Returns `404` if no image provider is enabled/available.
3. **Explicit `provider/model` aliases:** Pin the named provider and preserve the upstream model ID without falling back to another provider (e.g. `codex/gpt-image-1.5`, `github-copilot/gpt-image-2.5-flare`, `xai/grok-imagine-image-2.0`).
4. **Other bare model names:** Forwarded directly to `codex` as-is.
5. **Provider-scoped paths (`--provider <name>`):** Always target that provider; built-in providers fill their default model only when `model` is omitted/blank. Note: for xAI image **generation**, prefer top-level `--model xai/grok-imagine-image-2.0` so `copilot-api` translates OpenAI parameters (`size`, `quality`) and ensures `b64_json` output; provider-scoped `/xai/v1/images/generations` forwards native xAI JSON directly.

## Model & provider comparison

| Target / Model | Quality | Sizes / Resolution | Special capabilities & limits |
| --- | --- | --- | --- |
| `gpt-image-2` (`codex`) | `low`, `medium`, `high`, `auto` | `auto` or flexible `WIDTHxHEIGHT` (see constraints below) | Always high input fidelity (do not pass `input_fidelity`). No native `background=transparent`. Supports animated GIF (`output_format=gif`, `frame_count` 2-64, `frame_duration_ms` 20-2000) on `generate`. |
| `gpt-image-1.5` (`codex`) | `low`, `medium`, `high`, `auto` | `1024x1024`, `1536x1024`, `1024x1536`, `auto` | Supports `background=transparent` (`png`/`webp`) and `input_fidelity` (`low`/`high`, preserves first 5 inputs at high fidelity). |
| `gpt-image-1` / `gpt-image-1-mini` (`codex`) | `low`, `medium`, `high`, `auto` | `1024x1024`, `1536x1024`, `1024x1536`, `auto` | Legacy GPT Image compatibility (`input_fidelity` supported). |
| `github-copilot/gpt-image-2.5-flare` | `low`, `medium`, `high`, `auto` | OpenAI-compatible sizes (`auto`, `1024x1024`, `1536x1024`, `1024x1536`) | Uses GitHub Copilot OAuth token; JSON and multipart edits supported; no GIF output. |
| `xai/grok-imagine-image-2.0` | `low`, `medium`, `auto` (`high`/`hd` map to `medium`) | `size` translated to `aspect_ratio` + `resolution` (`1k`/`2k`); or pass `--aspect-ratio` / `--resolution` directly | Max **5** edit images. No `mask`, no `file_id`, no streaming, no GIF. Gateway returns `b64_json` by default (downloading from `imgen.x.ai` if upstream returned a URL). |

## `gpt-image-2` size constraints

`gpt-image-2` accepts `auto` or any `WIDTHxHEIGHT` satisfying all four rules:

- Maximum edge length `<= 3840px`
- Both width and height are multiples of `16px`
- Long-edge to short-edge ratio `<= 3:1`
- Total pixels between `655,360` and `8,294,400`

Popular valid sizes:
- `1024x1024` (fast square draft)
- `1536x1024` (landscape)
- `1024x1536` (portrait)
- `2048x2048` (2K square)
- `2048x1152` (2K widescreen)
- `3840x2160` (4K landscape)
- `2160x3840` (4K portrait)
- `auto`

## Edit transport & upload limits

- **Multipart (`multipart/form-data`, CLI default):** Supported across top-level `/v1/images/edits`, `/codex/v1/images/edits`, `/github-copilot/v1/images/edits`, `/xai/v1/images/edits`, and custom providers. Gateway limits: **128 MiB** total, **64 MiB** per file, up to **16** files (up to **5** for xAI).
- **JSON (`--transport json`):** Sends `images: [{ image_url: "data:image/...;base64,..." | "https://..." }]` and optional `mask: { image_url }`. Note that provider-scoped `/xai/v1/images/edits` with JSON expects native xAI JSON format, whereas multipart on `/xai/v1/images/edits` automatically applies xAI translation — prefer default `multipart` transport unless targeting a JSON-only endpoint.

## Response decoding

- Gateway responses contain OpenAI-compatible `data[]` items with `b64_json` and/or `url` (plus optional `revised_prompt`).
- `scripts/image_gen.mjs` decodes `b64_json` directly and writes atomically; when a provider returns a `url`, it downloads the image without forwarding `GITHUB_COPILOT_API_KEY` to the external host.
