import type { MediaUpload } from '../src/types/media'

/** xAI's media proxy rejects larger base64 image-to-video bodies. */
export const VIDEO_IMAGE_MAX_BYTES = 1024 * 1024

export interface CompressibleImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: {
    width: number
    height: number
    quality: 'good'
  }): CompressibleImage
  toJPEG(quality: number): Uint8Array
}

function jpegName(name: string): string {
  const stem = name.trim().replace(/\.[^.]+$/u, '')
  return stem ? stem + '.jpg' : 'frame.jpg'
}

export function compressRasterUnderLimit(
  image: CompressibleImage,
  maxBytes = VIDEO_IMAGE_MAX_BYTES,
): Uint8Array {
  if (image.isEmpty()) throw new Error('Could not read the video image')
  const original = image
  let { width, height } = image.getSize()
  if (width < 1 || height < 1) throw new Error('Could not read the video image')
  let quality = 80
  let current = image

  for (let attempt = 0; attempt < 40; attempt++) {
    const encoded = current.toJPEG(quality)
    if (encoded.byteLength > 0 && encoded.byteLength <= maxBytes)
      return new Uint8Array(encoded)
    if (quality > 40) {
      quality -= 10
      continue
    }
    const nextWidth = Math.max(1, Math.floor(width * 0.75))
    const nextHeight = Math.max(1, Math.floor(height * 0.75))
    if (nextWidth === width && nextHeight === height) break
    width = nextWidth
    height = nextHeight
    quality = 70
    current = original.resize({ width, height, quality: 'good' })
  }
  throw new Error('Could not compress the video image below 1 MiB')
}

export function compressVideoImage(
  image: MediaUpload,
  decode: (bytes: Uint8Array) => CompressibleImage,
): MediaUpload {
  if (image.bytes.byteLength <= VIDEO_IMAGE_MAX_BYTES) return image
  return {
    name: jpegName(image.name),
    type: 'image/jpeg',
    bytes: compressRasterUnderLimit(decode(image.bytes)),
  }
}
