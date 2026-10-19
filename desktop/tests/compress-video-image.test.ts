import { describe, expect, mock, test } from 'bun:test'

import {
  VIDEO_IMAGE_MAX_BYTES,
  compressRasterUnderLimit,
  compressVideoImage,
  type CompressibleImage,
} from '../electron/compress-video-image'
import type { MediaUpload } from '../src/types/media'

function fakeImage(
  width: number,
  height: number,
  bytesFor: (quality: number, width: number, height: number) => number,
  empty = false,
): CompressibleImage {
  return {
    isEmpty: () => empty,
    getSize: () => ({ width, height }),
    resize: (options) =>
      fakeImage(options.width, options.height, bytesFor, empty),
    toJPEG: (quality) => new Uint8Array(bytesFor(quality, width, height)),
  }
}

describe('video image compression', () => {
  test('leaves an image at or below 1 MiB unchanged', () => {
    const image: MediaUpload = {
      name: 'frame.png',
      type: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    }
    const decode = mock(() => fakeImage(1, 1, () => 1))
    expect(compressVideoImage(image, decode)).toBe(image)
    expect(decode).not.toHaveBeenCalled()
  })

  test('encodes an oversized image as JPEG under 1 MiB', () => {
    const bytes = new Uint8Array(VIDEO_IMAGE_MAX_BYTES + 1)
    const decode = mock((input: Uint8Array) => {
      expect(input).toBe(bytes)
      return fakeImage(80, 40, (quality) =>
        quality > 70 ? VIDEO_IMAGE_MAX_BYTES + 10 : 80,
      )
    })
    expect(
      compressVideoImage(
        { name: 'trip.png', type: 'image/png', bytes },
        decode,
      ),
    ).toEqual({
      name: 'trip.jpg',
      type: 'image/jpeg',
      bytes: new Uint8Array(80),
    })
  })

  test('shrinks the image when JPEG quality alone is not enough', () => {
    const encoded = compressRasterUnderLimit(
      fakeImage(80, 40, (_quality, width) => (width > 45 ? 1_000 : 40)),
      100,
    )
    expect(encoded.byteLength).toBe(40)
  })

  test('rejects an unreadable image', () => {
    expect(() =>
      compressRasterUnderLimit(fakeImage(8, 8, () => 1, true)),
    ).toThrow('Could not read the video image')
  })

  test('rejects an image that stays above the limit', () => {
    expect(() =>
      compressRasterUnderLimit(
        fakeImage(2, 2, () => 500),
        100,
      ),
    ).toThrow('Could not compress the video image below 1 MiB')
  })
})
