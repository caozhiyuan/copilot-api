# CLI Reference (`scripts/video_gen.mjs`)

Set a convenient script variable (works from any working directory):

```bash
export VIDEO_GEN=".agents/skills/copilot-api-videogen/scripts/video_gen.mjs"
```

Run with `node` (Node.js 20+) or `bun`.

## Dry run

Preview the resolved gateway URL, redacted auth status, default temp output path, and payload without spending credits:

```bash
node "$VIDEO_GEN" generate \
  --prompt "A glowing paper lantern floating over a quiet river at dusk" \
  --duration 5 \
  --aspect-ratio 16:9 \
  --resolution 720p \
  --dry-run
```

## Text-to-video (`generate`)

Submits the job, prints `request_id` immediately to stderr, polls until `done`, and downloads the MP4 atomically to `<os.tmpdir()>/copilot-api-videogen/` by default (pass `--out <path>` only when saving to a specific workspace path):

```bash
node "$VIDEO_GEN" generate \
  --prompt "A miniature steam train crossing a stone viaduct over misty pines at golden hour, steady aerial tracking shot, soft wind and distant whistle" \
  --duration 6 \
  --aspect-ratio 16:9 \
  --resolution 1080p \
  --audio
```

Silent clip (`--no-audio`) saved to an explicit workspace path:

```bash
node "$VIDEO_GEN" generate \
  --prompt "Minimalist matte ceramic mug rotating slowly on a limestone pedestal, soft studio lighting" \
  --duration 4 \
  --aspect-ratio 1:1 \
  --resolution 720p \
  --no-audio \
  --out ./assets/mug-turntable.mp4
```

## Image-to-video (`--image`)

Animate a local still image (encoded automatically to a base64 data URL) or an `https://` image URL:

```bash
node "$VIDEO_GEN" generate \
  --image /path/to/mug-hero.png \
  --prompt "Gentle steam curls upward from the coffee while soft sunlight slowly shifts across the stone surface, locked camera" \
  --duration 5 \
  --resolution 1080p
```

## First & last frame transition / seamless loop

Pin both the first and last frames (pass the same image for both to create a seamless loop):

```bash
node "$VIDEO_GEN" generate \
  --image input/day-street.png \
  --last-frame input/night-street.png \
  --prompt "Smooth time-lapse transition from late afternoon into blue hour as streetlights switch on, locked tripod camera" \
  --duration 6 \
  --resolution 720p
```

## Reference-to-video (`--ref-image`)

Pass up to 14 reference images and cite them by 0-based index (`<IMAGE_0>`, `<IMAGE_1>`, ...; if `--image` is also passed, `--image` takes `<IMAGE_0>` and `--ref-image` starts at `<IMAGE_1>`):

```bash
node "$VIDEO_GEN" generate \
  --ref-image input/character.png \
  --ref-image input/cafe.png \
  --prompt "The character from <IMAGE_0> sits by the sunlit window of the cafe in <IMAGE_1>, lifts a ceramic cup, and smiles toward the camera, natural ambient cafe sound" \
  --duration 6 \
  --aspect-ratio 16:9 \
  --resolution 720p
```

## Split async workflow (`submit`, `status`, `wait`)

Submit without waiting (returns `request_id` immediately):

```bash
node "$VIDEO_GEN" submit \
  --prompt "Ocean waves breaking over dark volcanic rocks in slow motion" \
  --duration 5 \
  --aspect-ratio 16:9 \
  --resolution 720p \
  --json
```

Check status once (add `--download` if already `done`; defaults to `<os.tmpdir()>/copilot-api-videogen/`, or add `--out <path>`):

```bash
node "$VIDEO_GEN" status \
  --request-id YOUR_REQUEST_ID \
  --download
```

Resume polling an existing job and download when finished (defaults to `<os.tmpdir()>/copilot-api-videogen/`, or add `--out <path>`):

```bash
node "$VIDEO_GEN" wait \
  --request-id YOUR_REQUEST_ID \
  --poll-interval-ms 5000 \
  --timeout-ms 600000
```

## Advanced native fields (`--extra-json`)

`copilot-api` forwards native xAI video fields untouched, so additional options such as `keyframes`, `reference_audios`, or `storage_options` can be passed via `--extra-json`:

```bash
node "$VIDEO_GEN" generate \
  --prompt "Character speaking in a quiet studio" \
  --duration 6 \
  --resolution 720p \
  --extra-json '{"reference_audios":[{"voice":"eve"}]}' \
  --dry-run
```
