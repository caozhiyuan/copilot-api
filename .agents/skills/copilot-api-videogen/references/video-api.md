# Video API Reference (`copilot-api`)

## Endpoints

Top-level only (no provider-scoped video routes):

- `POST /v1/videos/generations` (alias: `/videos/generations`) — submit an asynchronous xAI video job; returns `{ "request_id": "..." }`.
- `GET /v1/videos/{request_id}` (alias: `/videos/{request_id}`) — poll job status and retrieve the temporary `video.url` once `status` is `"done"`.

Authentication uses `Authorization: Bearer $GITHUB_COPILOT_API_KEY`.

## Gateway constraints & ownership

Based on `src/routes/videos/route.ts` and `src/services/xai/videos.ts`:

- **Model validation:** `model` is required and has no server default. After applying `modelMappings`, it must resolve to `xai/grok-imagine-video-1.5` (otherwise `400 invalid_request_error`).
- **Provider availability:** Requires an enabled `xai` provider (OAuth or API key); otherwise returns `404 Provider 'xai' not found or disabled`.
- **API key ownership:** When the gateway uses API keys, `GET /v1/videos/{request_id}` enforces that the polling key matches the submitting key (otherwise `403 Video job does not belong to this API key`).
- **Background billing settlement:** Jobs submitted with a gateway API key are persisted so `copilot-api` settles upstream cost (`usage.cost_in_usd_ticks`) in the background even across restarts. Keep the same `xai` account and base URL during settlement.

## Request parameters (`grok-imagine-video-1.5`)

| Field | Type | Notes |
| --- | --- | --- |
| `model` | `string` | Required. Default `"xai/grok-imagine-video-1.5"` (or a `modelMappings` alias pointing to it). |
| `prompt` | `string` | Required for text-to-video; optional when `image` or `last_frame` is supplied. |
| `duration` | `integer` | `1` to `15` seconds (xAI default `8`). |
| `aspect_ratio` | `string` | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3`, `21:9`, `5:2`. Omit for image-to-video to follow input framing unless overriding. |
| `resolution` | `string` | `480p`, `720p`, `1080p`. Native `1080p` is supported for text-to-video and image-to-video; reference-to-video supports up to `720p`. |
| `generate_audio` | `boolean` | Controls generated audio track (including lip-synced speech). |
| `image` | `{ url: string }` | First-frame image (`https://...` or `data:image/<mime>;base64,...`). Keep local base64 files under ~1 MiB (compress/resize or use an `https://` URL) to avoid xAI media-proxy size rejections. |
| `last_frame` | `{ url: string }` | Optional pinned last-frame image. |
| `reference_images` | `Array<{ url: string }>` | Up to 14 reference images for reference-to-video. |

All remaining native xAI JSON fields (for example `keyframes`, `reference_audios`, `storage_options`) are forwarded untouched by `copilot-api`.

## Status lifecycle & response shape

Submission response:

```json
{
  "request_id": "d97415a1-5796-b7ec-379f-4e6819e08fdf"
}
```

Polling response:

| `status` | Meaning |
| --- | --- |
| `pending` / `processing` | Video is still rendering (may include numeric `progress` 0-100). Continue polling. |
| `done` | Video completed. Check `video.respect_moderation !== false` and download `video.url` promptly (temporary URL). |
| `failed` | Generation failed; inspect `error.code` / `error.message`. |
| `expired` | Job expired before completion or retrieval. |

Completed payload example:

```json
{
  "status": "done",
  "video": {
    "url": "https://vidgen.x.ai/.../clip.mp4",
    "duration": 8,
    "respect_moderation": true
  },
  "model": "grok-imagine-video-1.5",
  "progress": 100
}
```

## Download safety

`video.url` points to an external temporary host (such as `vidgen.x.ai`). `scripts/video_gen.mjs` downloads it over plain `GET` without sending `Authorization: Bearer $GITHUB_COPILOT_API_KEY`, writes atomically via a `.tmp` sibling file, and refuses to overwrite existing files unless `--force` is passed.
