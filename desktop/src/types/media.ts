export const IMAGE_SIZES = [
  'auto',
  '1024x1024',
  '1536x1024',
  '1024x1536',
] as const
export const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high'] as const
export const VIDEO_RATIOS = [
  '16:9',
  '9:16',
  '1:1',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '21:9',
  '5:2',
] as const
export const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
export const MAX_TOTAL_UPLOAD_BYTES = 40 * 1024 * 1024
export const UPLOAD_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp']
export const VIDEO_MODEL = 'xai/grok-imagine-video-1.5'

export interface MediaUpload {
  name: string
  type: string
  bytes: Uint8Array
}

export interface ImageCreationInput {
  mode: 'generate' | 'edit'
  provider: 'default' | 'codex' | 'xai'
  model: string
  prompt: string
  size: (typeof IMAGE_SIZES)[number]
  quality: (typeof IMAGE_QUALITIES)[number]
  n: number
  images: MediaUpload[]
}

export interface CreatedImage {
  url: string
  revisedPrompt?: string
}

export interface VideoCreationInput {
  prompt: string
  duration: number
  aspectRatio: (typeof VIDEO_RATIOS)[number]
  resolution: (typeof VIDEO_RESOLUTIONS)[number]
  generateAudio: boolean
  image?: MediaUpload
}

export interface VideoCreationResult {
  requestId?: string
  status: 'pending' | 'done' | 'failed' | 'expired'
  url?: string
  error?: string
}

export interface SaveMediaInput {
  url: string
  kind: 'image' | 'video'
}
