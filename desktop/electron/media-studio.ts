import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  translateXaiImageEditJson,
  translateXaiImageGeneration,
} from '../../src/services/xai/images'
import {
  IMAGE_QUALITIES,
  IMAGE_SIZES,
  MAX_TOTAL_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_MIME_TYPES,
  VIDEO_MODEL,
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  type CreatedImage,
  type ImageCreationInput,
  type MediaUpload,
  type SaveMediaInput,
  type VideoCreationInput,
  type VideoCreationResult,
} from '../src/types/media'

type MediaFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

interface MediaClientOptions {
  getBaseUrl: () => string
  getHeaders: () => Promise<Record<string, string> | undefined>
  fetch?: MediaFetch
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}

function errorMessage(value: unknown): string | undefined {
  const error = record(value).error
  if (typeof error === 'string') return error
  const message =
    record(error).message ?? record(value).message ?? record(value).detail
  return typeof message === 'string' ? message : undefined
}

function validatePrompt(prompt: string): string {
  if (typeof prompt !== 'string' || !prompt.trim())
    throw new Error('A prompt is required')
  return prompt.trim()
}

function validateVideoPrompt(
  prompt: unknown,
  hasImage: boolean,
): string | undefined {
  if (typeof prompt !== 'string') throw new Error('Invalid video options')
  const normalized = prompt.trim()
  if (!normalized && !hasImage)
    throw new Error('A prompt or first-frame image is required')
  return normalized || undefined
}

function validateUploads(images: MediaUpload[], max: number): void {
  if (!Array.isArray(images) || images.length > max)
    throw new Error(`At most ${max} images are supported`)
  let total = 0
  for (const image of images) {
    if (
      !image
      || !UPLOAD_MIME_TYPES.includes(image.type)
      || !(image.bytes instanceof Uint8Array)
      || !image.bytes.length
      || image.bytes.length > MAX_UPLOAD_BYTES
    ) {
      throw new Error('Upload a PNG, JPEG or WebP image up to 20 MiB')
    }
    total += image.bytes.length
  }
  if (total > MAX_TOTAL_UPLOAD_BYTES)
    throw new Error('Images must total at most 40 MiB')
}

function uploadUrl(image: MediaUpload): string {
  return `data:${image.type};base64,${Buffer.from(image.bytes).toString('base64')}`
}

export function validateMediaUrl(
  url: string,
  kind: SaveMediaInput['kind'],
): string {
  if (kind !== 'image' && kind !== 'video')
    throw new Error('Invalid media kind')
  if (typeof url !== 'string' || !url.trim())
    throw new Error('Missing media URL')
  if (
    kind === 'image'
    && /^data:image\/(png|jpeg|webp|gif);base64,[a-z\d+/=\s]+$/i.test(url)
  )
    return url
  const parsed = new URL(url)
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
  )
    throw new Error('Unsupported media URL')
  return parsed.href
}

export function mediaFileExtension(input: SaveMediaInput): string {
  const url = validateMediaUrl(input.url, input.kind)
  if (input.kind === 'video') return 'mp4'
  const mime = /^data:image\/(png|jpeg|webp|gif);/i.exec(url)?.[1]
  return (
    mime
    ?? /\.(png|jpe?g|webp|gif)$/i
      .exec(new URL(url).pathname)?.[1]
      ?.toLowerCase()
    ?? 'png'
  )
}

function imageMime(base64: string, format: unknown): string {
  const bytes = Buffer.from(base64.slice(0, 24), 'base64')
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF') return 'webp'
  if (bytes.toString('ascii', 0, 3) === 'GIF') return 'gif'
  return format === 'jpeg' || format === 'webp' ? format : 'png'
}

export function parseCreatedImages(value: unknown): CreatedImage[] {
  const payload = record(value)
  if (!Array.isArray(payload.data) || !payload.data.length)
    throw new Error(errorMessage(value) ?? 'No images were returned')
  return payload.data.map((item: unknown) => {
    const image = record(item)
    const url =
      typeof image.b64_json === 'string' && image.b64_json ?
        `data:image/${imageMime(image.b64_json, payload.output_format)};base64,${image.b64_json}`
      : image.url
    if (typeof url !== 'string') throw new Error('Invalid image response')
    return {
      url: validateMediaUrl(url, 'image'),
      ...(typeof image.revised_prompt === 'string' && {
        revisedPrompt: image.revised_prompt,
      }),
    }
  })
}

export function parseVideoResult(value: unknown): VideoCreationResult {
  const payload = record(value)
  const status = payload.status
  const requestId =
    typeof payload.request_id === 'string' ? payload.request_id : undefined
  if (status === 'failed' || status === 'expired')
    return { status, requestId, error: errorMessage(value) }
  if (status === 'done') {
    const video = record(payload.video)
    if (video.respect_moderation === false)
      return {
        status: 'failed',
        requestId,
        error: 'The video was filtered by moderation',
      }
    if (typeof video.url !== 'string')
      throw new Error('The completed video has no URL')
    return {
      status: 'done',
      requestId,
      url: validateMediaUrl(video.url, 'video'),
    }
  }
  if (status === 'pending' || status === 'processing' || (!status && requestId))
    return { status: 'pending', requestId }
  throw new Error(errorMessage(value) ?? 'Invalid video response')
}

export function createMediaStudioClient(options: MediaClientOptions) {
  const requests = new Map<string, AbortController>()
  const fetchMedia: MediaFetch = (input, init) =>
    (options.fetch ?? fetch)(input, init)

  async function request(
    id: string,
    path: string,
    init: RequestInit,
  ): Promise<unknown> {
    if (typeof id !== 'string' || !id || requests.has(id))
      throw new Error('Invalid or duplicate request ID')
    const controller = new AbortController()
    requests.set(id, controller)
    try {
      const headers = await options.getHeaders()
      controller.signal.throwIfAborted()
      const response = await fetchMedia(`${options.getBaseUrl()}${path}`, {
        ...init,
        headers: { ...headers, ...init.headers },
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15 * 60 * 1000),
        ]),
      })
      const body: unknown = await response.json()
      if (!response.ok)
        throw new Error(errorMessage(body) ?? `HTTP ${response.status}`)
      return body
    } finally {
      requests.delete(id)
    }
  }

  return {
    cancel(id: string) {
      requests.get(id)?.abort()
    },
    cancelAll() {
      for (const controller of requests.values()) controller.abort()
    },
    async createImages(
      id: string,
      input: ImageCreationInput,
    ): Promise<CreatedImage[]> {
      const prompt = validatePrompt(input.prompt)
      if (
        !['generate', 'edit'].includes(input.mode)
        || !['default', 'codex', 'xai'].includes(input.provider)
        || typeof input.model !== 'string'
        || !input.model.trim()
        || !IMAGE_SIZES.includes(input.size)
        || !IMAGE_QUALITIES.includes(input.quality)
        || !Number.isInteger(input.n)
        || input.n < 1
        || input.n > 4
      )
        throw new Error('Invalid image options')
      validateUploads(input.images, 5)
      if (input.mode === 'edit' && !input.images.length)
        throw new Error('Select an image to edit')
      const payload = {
        model: input.model.trim(),
        prompt,
        n: input.n,
        size: input.size,
        quality: input.quality,
      }
      const operation = input.mode === 'edit' ? 'edits' : 'generations'
      const prefix = input.provider === 'default' ? '' : `/${input.provider}`
      let body: string
      if (input.provider === 'xai') {
        body = JSON.stringify(
          input.mode === 'edit' ?
            translateXaiImageEditJson(
              {
                ...payload,
                images: input.images.map(uploadUrl),
                response_format: 'b64_json',
              },
              payload.model,
            )
          : translateXaiImageGeneration(
              { ...payload, response_format: 'b64_json' },
              payload.model,
            ),
        )
      } else if (input.mode === 'edit') {
        body = JSON.stringify({
          ...payload,
          images: input.images.map((image) => ({
            image_url: uploadUrl(image),
          })),
        })
      } else body = JSON.stringify(payload)
      return parseCreatedImages(
        await request(id, `${prefix}/v1/images/${operation}`, {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/json' },
        }),
      )
    },
    async createVideo(
      id: string,
      input: VideoCreationInput,
    ): Promise<VideoCreationResult> {
      const hasImage = Boolean(input.image)
      const prompt = validateVideoPrompt(input.prompt, hasImage)
      if (
        !Number.isInteger(input.duration)
        || input.duration < 1
        || input.duration > 15
        || !VIDEO_RATIOS.includes(input.aspectRatio)
        || !VIDEO_RESOLUTIONS.includes(input.resolution)
        || typeof input.generateAudio !== 'boolean'
      )
        throw new Error('Invalid video options')
      validateUploads(hasImage && input.image ? [input.image] : [], 1)
      const result = parseVideoResult(
        await request(id, '/v1/videos/generations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: VIDEO_MODEL,
            ...(prompt ? { prompt } : {}),
            duration: input.duration,
            resolution: input.resolution,
            generate_audio: input.generateAudio,
            ...(input.image ?
              { image: { url: uploadUrl(input.image) } }
            : { aspect_ratio: input.aspectRatio }),
          }),
        }),
      )
      if (result.status === 'pending' && !result.requestId)
        throw new Error('No video request ID was returned')
      return result
    },
    async getVideo(
      id: string,
      requestId: string,
    ): Promise<VideoCreationResult> {
      if (
        typeof requestId !== 'string'
        || !requestId.trim()
        || requestId === '.'
        || requestId === '..'
        || /[/\\]/u.test(requestId)
      )
        throw new Error('Invalid video request ID')
      return parseVideoResult(
        await request(id, `/v1/videos/${encodeURIComponent(requestId)}`, {
          method: 'GET',
        }),
      )
    },
  }
}

/** Stage downloads beside the destination so failures never truncate an existing file. */
export async function saveMediaFile(
  input: SaveMediaInput,
  filePath: string,
  fetchMedia: MediaFetch = fetch,
): Promise<void> {
  const url = validateMediaUrl(input.url, input.kind)
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    // Electron's net.fetch does not support data URLs. Decode images locally.
    if (url.startsWith('data:')) {
      await writeFile(
        temporaryPath,
        Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'),
        { flag: 'wx' },
      )
    } else {
      const response = await fetchMedia(url, {
        signal: AbortSignal.timeout(5 * 60 * 1000),
      })
      if (!response.ok || !response.body)
        throw new Error(`Download failed: HTTP ${response.status}`)
      await pipeline(
        Readable.fromWeb(
          response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
        ),
        createWriteStream(temporaryPath, { flags: 'wx' }),
      )
    }
    await rename(temporaryPath, filePath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}
