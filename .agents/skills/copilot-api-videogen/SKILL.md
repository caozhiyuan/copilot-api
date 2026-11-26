---
name: copilot-api-videogen
description: Generate videos asynchronously through a running copilot-api gateway (/v1/videos/generations and /v1/videos/{request_id}, backed by xai/grok-imagine-video-1.5) using GITHUB_COPILOT_API_KEY and COPILOT_API_BASE_URL. Supports text-to-video, image-to-video (animating a first frame), pinned first/last frame transitions, reference-to-video (up to 14 reference images), audio toggling, status polling, and automatic MP4 download (also triggers on videogen, generate video, text to video, image to video). Do not use for programmatic UI animations better authored in CSS/Canvas/SVG or lossless trimming/concatenation of existing video files with ffmpeg.
---

# Copilot API Video Generation Skill

Generate short AI videos through a running `copilot-api` gateway using the bundled zero-dependency Node.js/Bun CLI (`scripts/video_gen.mjs`).

`copilot-api` exposes native asynchronous xAI video generation (`POST /v1/videos/generations` and `GET /v1/videos/{request_id}`) backed by `xai/grok-imagine-video-1.5` (requires the `xai` provider to be enabled in `copilot-api`).

## When to use

- Generate a video from a text prompt (text-to-video, 1-15s, up to native 1080p)
- Animate an existing still image (image-to-video via `--image`)
- Interpolate between a pinned first frame and pinned last frame (or create seamless loops via `--image` + `--last-frame`)
- Guide a scene with up to 14 reference images (`--ref-image`, referenced as `<IMAGE_0>`, `<IMAGE_1>`, ...)
- Submit jobs asynchronously (`submit`) and check/wait/download later (`status` / `wait`)

## When not to use

- Programmatic UI motion, charts, or animations better implemented in CSS, Canvas, SVG, or code
- Deterministic trimming, transcoding, subtitle burn-in, or concatenation of existing videos (use `ffmpeg`)
- Generating a still image (use `copilot-api-imagegen`)

## Quick start

Resolve `<SKILL_DIR>` relative to this `SKILL.md` (in this repository: `.agents/skills/copilot-api-videogen`):

```bash
export VIDEO_GEN=".agents/skills/copilot-api-videogen/scripts/video_gen.mjs"
```

Preview a request with `--dry-run` before spending video generation credits:

```bash
node "$VIDEO_GEN" generate \
  --prompt "A small paper boat drifting across a misty alpine lake at sunrise, gentle ripples, slow low tracking camera shot" \
  --duration 5 \
  --aspect-ratio 16:9 \
  --resolution 720p \
  --dry-run
```

## Decision tree

1. **Input mode:**
   - Text only -> `--prompt "..."` (optionally `--aspect-ratio`, `--duration`, `--resolution`)
   - Animate a still image -> `--image path/to/first-frame.png` (optional `--prompt`; omit `--aspect-ratio` unless overriding)
   - Pinned start + end frame (or loop) -> `--image start.png --last-frame end.png` (optional `--prompt`)
   - Character/prop consistency across references -> repeatable `--ref-image` (up to 14) referenced in `--prompt` as `<IMAGE_0>`, `<IMAGE_1>`, ... (use `--resolution 720p` or `480p` for reference-to-video; note that if `--image` is also set, `--image` takes `<IMAGE_0>` and `--ref-image` starts at `<IMAGE_1>`)
2. **Execution mode:**
   - Standard single video -> `generate` (submits, prints `request_id` immediately, polls until `done`, downloads MP4 atomically to `--out`)
   - Launching multiple clips in parallel or non-blocking submit -> `submit` (returns `request_id` immediately), then `status` / `wait --request-id <id> --out ...`

## Workflow

1. Clarify duration (1-15s), resolution (`480p` / `720p` / `1080p`), aspect ratio (for text-to-video), audio preference (`--audio` / `--no-audio`), and any input frame/reference image paths.
2. Check cost/latency expectations when generating long or 1080p clips: start with shorter duration (e.g. `5s`) and `720p` for drafts before rendering `1080p` or `15s` finals.
3. Structure the prompt cleanly with subject, motion/action beats, camera movement, lighting/atmosphere, and audio/speech cues (see `references/prompting.md`).
4. Run `node "$VIDEO_GEN" generate ...` (use `--dry-run` first if using multiple images or `--extra-json`).
5. **Preserve the printed `request_id`:** if polling ever times out or is interrupted, resume with `node "$VIDEO_GEN" wait --request-id <id> --out <path>` rather than resubmitting a duplicate paid job.
6. Download promptly: `video.url` returned by xAI is temporary. `generate` and `wait` download the MP4 automatically unless `--no-download` is specified.
7. Report the saved MP4 path, `request_id`, duration/resolution, and final prompt.

## Model & gateway notes

- Default model: `xai/grok-imagine-video-1.5` (the gateway rejects other models unless mapped via `modelMappings` to `xai/grok-imagine-video-1.5`).
- Top-level endpoints only: `/v1/videos/generations` and `/v1/videos/{request_id}`.
- Requires the `xai` provider to be enabled in `copilot-api` (`404` if disabled).
- When gateway API key authentication is enabled, polling `GET /v1/videos/{request_id}` **must** use the same `GITHUB_COPILOT_API_KEY` that submitted the job (otherwise the gateway returns `403`).

## Output conventions

- By default, clips are downloaded to a unique MP4 inside the OS temporary directory (`<os.tmpdir()>/copilot-api-videogen/`) so the current project directory stays clean and consecutive runs do not collide.
- Pass `--out <path>` only when the user explicitly requests saving the clip to a specific workspace path.
- Existing files are never overwritten unless `--force` is passed (checked before submitting a paid job in `generate` mode).

## Environment & security

- `GITHUB_COPILOT_API_KEY`: gateway API key sent as `Authorization: Bearer <key>` (the shared client key variable used across `copilot-api`).
  - Optional only on unauthenticated loopback gateways (`localhost`, `127.0.0.1`, `::1`).
  - Required on protected or non-loopback gateways, and must stay consistent between submit and poll.
- `COPILOT_API_BASE_URL`: optional gateway root URL (default `http://localhost:4141`).
- Never ask the user to paste the full key in chat, never log/echo the key, and never pass keys via CLI flags. Gateway auth headers are never sent to the external video download host.

## Guardrails

- Use `scripts/video_gen.mjs` directly; do not write ad-hoc polling scripts unless requested.
- Never blindly resubmit a video job after a polling timeout — always check/resume the existing `request_id` with `status` or `wait`.
- Treat `video.respect_moderation === false` as a failed moderation result.

## Reference map

- `references/cli.md`: CLI subcommands (`generate`, `submit`, `status`, `wait`) and recipes.
- `references/video-api.md`: `copilot-api` `/v1/videos/*` contract, status lifecycle, ownership rules, and xAI parameter limits.
- `references/prompting.md`: video prompting structure, camera/motion cues, audio/dialogue, and `<IMAGE_N>` reference guidance.
- `scripts/video_gen.mjs`: standalone zero-dependency Node.js/Bun CLI.
