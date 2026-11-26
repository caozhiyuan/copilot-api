# CLI Reference (`scripts/image_gen.mjs`)

Set a convenient script variable (works from any working directory):

```bash
export IMAGE_GEN=".agents/skills/copilot-api-imagegen/scripts/image_gen.mjs"
```

Run with `node` (Node.js 20+) or `bun`.

## Dry run

Preview the resolved gateway URL, redacted auth status, default temp output path(s), and payload without network access:

```bash
node "$IMAGE_GEN" generate \
  --prompt "A cozy alpine cabin at dawn" \
  --size 1024x1024 \
  --dry-run
```

## Generate (`generate`)

Omit `--out` to write to a unique file inside `<os.tmpdir()>/copilot-api-imagegen/` without polluting the current project directory. Pass `--out <path>` only when you explicitly want to save to a specific destination.

Fast square draft (writes to OS temp dir):

```bash
node "$IMAGE_GEN" generate \
  --prompt "A product thumbnail of a matte ceramic mug on warm stone" \
  --quality low \
  --size 1024x1024
```

Final 2K landscape with prompt augmentation fields (explicit workspace destination):

```bash
node "$IMAGE_GEN" generate \
  --prompt "A minimal hero image of a ceramic coffee mug" \
  --use-case product-mockup \
  --style "clean product photography" \
  --composition "wide product shot with negative space on the left for page copy" \
  --lighting "soft studio daylight" \
  --constraints "no logos, no text, no watermark" \
  --size 2048x1152 \
  --quality high \
  --out ./assets/mug-hero.png
```

4K landscape (`gpt-image-2`):

```bash
node "$IMAGE_GEN" generate \
  --prompt "Architectural visualization of a glass pavilion in misty pines at golden hour" \
  --size 3840x2160 \
  --quality high
```

Animated GIF (Codex `gpt-image-2` only):

```bash
node "$IMAGE_GEN" generate \
  --prompt "A pixel-art campfire flickering gently at night" \
  --output-format gif \
  --frame-count 12 \
  --frame-duration-ms 150 \
  --size 1024x1024
```

Native transparent PNG (confirm switching to `gpt-image-1.5` first unless requested):

```bash
node "$IMAGE_GEN" generate \
  --model gpt-image-1.5 \
  --prompt "Clean product cutout of a matte ceramic mug" \
  --background transparent \
  --output-format png
```

Pin a specific provider via `provider/model` alias or `--provider`:

```bash
# GitHub Copilot GPT Image 2.5 Flare
node "$IMAGE_GEN" generate \
  --model github-copilot/gpt-image-2.5-flare \
  --prompt "Clean isometric server rack illustration"

# xAI Grok Imagine Image 2.0
node "$IMAGE_GEN" generate \
  --model xai/grok-imagine-image-2.0 \
  --prompt "Editorial portrait in soft window light" \
  --aspect-ratio 3:4 \
  --resolution 2k

# Omit model to use gateway default provider selection without sending gpt-image-2
node "$IMAGE_GEN" generate \
  --auto-model \
  --prompt "A paper boat on a calm alpine lake"
```

## Edit (`edit`)

Single-image edit (uses `multipart/form-data` by default, compatible with Codex, GitHub Copilot, xAI, and custom providers; omits `--out` to write a new file in `<os.tmpdir()>/copilot-api-imagegen/`):

```bash
node "$IMAGE_GEN" edit \
  --image input/mug.png \
  --prompt "Replace only the background with a warm sunset gradient" \
  --use-case precise-object-edit \
  --constraints "change only the background; keep the mug, glaze, and edges unchanged"
```

Multi-image compositing / style transfer (order of `--image` flags is preserved):

```bash
node "$IMAGE_GEN" edit \
  --image input/subject.png \
  --image input/style-ref.png \
  --prompt "Image 1 is the base subject to preserve; Image 2 is the watercolor texture and palette reference. Restyle Image 1 in the watercolor medium of Image 2 while keeping pose and framing identical."
```

Mask-guided edit (PNG with alpha channel; applies to the first `--image`; not supported on xAI):

```bash
node "$IMAGE_GEN" edit \
  --model gpt-image-1.5 \
  --image input/room.png \
  --mask input/sofa-mask.png \
  --input-fidelity high \
  --prompt "Replace the masked sofa with a mid-century walnut bench; keep walls, floor, and lighting unchanged"
```

JSON edit transport (sends `images: [{ image_url: "data:..." | "https://..." }]`):

```bash
node "$IMAGE_GEN" edit \
  --transport json \
  --image input/mug.png \
  --prompt "Add gentle steam rising from the coffee"
```

## Concurrent batch (`generate-batch`)

Create a JSONL file inside the OS temp directory, run concurrently (omit `--out-dir` to output into a unique folder under `<os.tmpdir()>/copilot-api-imagegen/`), and remove the temp JSONL file afterward:

```bash
BATCH_TMP="${TMPDIR:-/tmp}/copilot-api-imagegen"
mkdir -p "$BATCH_TMP"
cat > "$BATCH_TMP/prompts.jsonl" << 'EOF'
{"prompt":"Cavernous hangar interior with a compact shuttle parked near the center","use_case":"stylized-concept","composition":"wide-angle, low-angle","lighting":"volumetric light rays through fog","size":"1536x1024","out":"hangar.png"}
{"prompt":"Gray wolf in profile in a snowy pine forest","use_case":"photorealistic-natural","composition":"eye-level","size":"1024x1024","out":"wolf.png"}
EOF

node "$IMAGE_GEN" generate-batch \
  --input "$BATCH_TMP/prompts.jsonl" \
  --concurrency 5

rm -f "$BATCH_TMP/prompts.jsonl"
```

Batch notes:
- `--out-dir` is optional; when omitted, outputs are written to a unique directory under `<os.tmpdir()>/copilot-api-imagegen/` (pass `--out-dir <dir>` to target a specific workspace folder).
- Per-job `out` must be a plain filename inside `--out-dir` (subpaths and `..` are rejected).
- Supported per-job JSONL overrides: `prompt`, `model`, `provider`, `size`, `quality`, `background`, `output_format`, `output_compression`, `frame_count`, `frame_duration_ms`, `moderation`, `aspect_ratio`, `resolution`, `n`, `out`, and all prompt augmentation fields (`use_case`, `scene`, `subject`, `style`, `composition`, `lighting`, `palette`, `materials`, `text`, `constraints`, `negative`).
- Use `--fail-fast` to stop scheduling remaining jobs on the first failure.

## Output & overwrite behavior

- When `--out` / `--out-dir` is omitted, files are written to unique paths inside `<os.tmpdir()>/copilot-api-imagegen/`.
- Reruns targeting an explicit existing `--out` path refuse to overwrite unless `--force` is passed.
- Files are written atomically via temporary sibling files and renamed on success.
- Pass `--json` to emit machine-readable JSON (`outputs`, `revised_prompts`, `endpoint`, `model`) on stdout.
