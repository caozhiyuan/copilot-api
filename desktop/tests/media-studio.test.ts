import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createMediaStudioClient,
  mediaFileExtension,
  parseCreatedImages,
  parseVideoResult,
  saveMediaFile,
  validateMediaUrl,
} from '../electron/media-studio'
import type {
  ImageCreationInput,
  MediaUpload,
  VideoCreationInput,
} from '../src/types/media'

const image: MediaUpload = {
  name: 'source.png',
  type: 'image/png',
  bytes: new Uint8Array([137, 80, 78, 71]),
}
const imageInput: ImageCreationInput = {
  mode: 'generate',
  provider: 'default',
  model: 'gpt-image-2',
  prompt: ' A boat ',
  size: '1024x1024',
  quality: 'high',
  n: 2,
  images: [],
}
const videoInput: VideoCreationInput = {
  prompt: ' A moving boat ',
  duration: 8,
  aspectRatio: '16:9',
  resolution: '720p',
  generateAudio: true,
}
let response: () => Response
const fetchMock = mock(
  (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(response()),
)
const client = () =>
  createMediaStudioClient({
    getBaseUrl: () => 'http://[::1]:5151',
    getHeaders: () => Promise.resolve({ 'x-api-key': 'gateway-key' }),
    fetch: fetchMock,
  })

beforeEach(() => {
  fetchMock.mockClear()
  response = () => Response.json({ data: [{ b64_json: 'iVBORw==' }] })
})

describe('media requests', () => {
  test('sends image options through the running gateway with its auth', async () => {
    const result = await client().createImages('one', imageInput)
    expect(result[0].url).toBe('data:image/png;base64,iVBORw==')
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://[::1]:5151/v1/images/generations',
    )
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      'x-api-key': 'gateway-key',
      'content-type': 'application/json',
    })
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      model: 'gpt-image-2',
      prompt: 'A boat',
      size: '1024x1024',
      quality: 'high',
      n: 2,
    })
  })
  test('explicit Codex bypasses the default image route settings', async () => {
    await client().createImages('one', { ...imageInput, provider: 'codex' })
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://[::1]:5151/codex/v1/images/generations',
    )
  })
  test.each(['default', 'codex'] as const)(
    'sends multiple edit images as JSON to %s',
    async (provider) => {
      await client().createImages('one', {
        ...imageInput,
        provider,
        mode: 'edit',
        images: [
          image,
          {
            ...image,
            name: 'two.webp',
            type: 'image/webp',
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      })
      const init = fetchMock.mock.calls[0][1]!
      expect(fetchMock.mock.calls[0][0]).toBe(
        `http://[::1]:5151${provider === 'codex' ? '/codex' : ''}/v1/images/edits`,
      )
      expect(init.headers).toEqual({
        'x-api-key': 'gateway-key',
        'content-type': 'application/json',
      })
      expect(JSON.parse(init.body as string)).toEqual({
        model: 'gpt-image-2',
        prompt: 'A boat',
        n: 2,
        size: '1024x1024',
        quality: 'high',
        images: [
          { image_url: 'data:image/png;base64,iVBORw==' },
          { image_url: 'data:image/webp;base64,AQID' },
        ],
      })
    },
  )
  test.each(['generate', 'edit'] as const)(
    'translates explicit xAI %s to its native JSON protocol',
    async (mode) => {
      await client().createImages('one', {
        ...imageInput,
        provider: 'xai',
        model: 'grok-imagine-image-2.0',
        mode,
        images: mode === 'edit' ? [image] : [],
      })
      expect(fetchMock.mock.calls[0][0]).toBe(
        `http://[::1]:5151/xai/v1/images/${mode === 'edit' ? 'edits' : 'generations'}`,
      )
      const body: unknown = JSON.parse(
        fetchMock.mock.calls[0][1]?.body as string,
      )
      expect(body).toMatchObject({
        model: 'grok-imagine-image-2.0',
        aspect_ratio: '1:1',
        quality: 'medium',
        resolution: '1k',
        n: 2,
        response_format: 'b64_json',
      })
      if (mode === 'edit')
        expect(body).toHaveProperty(
          'image.url',
          'data:image/png;base64,iVBORw==',
        )
    },
  )
  test.each([
    { prompt: ' ' },
    { model: '' },
    { n: 0 },
    { n: 5 },
    { n: 1.5 },
    { size: 'bad' },
    { quality: 'bad' },
    { provider: 'bad' },
    { mode: 'bad' },
    { mode: 'edit' },
    { images: Array.from({ length: 6 }, () => image) },
    { images: [{ ...image, type: 'image/svg+xml' }] },
    { images: [{ ...image, bytes: new Uint8Array() }] },
    { images: [{ ...image, bytes: new Uint8Array(20 * 1024 * 1024 + 1) }] },
    {
      images: Array.from({ length: 3 }, () => ({
        ...image,
        bytes: new Uint8Array(15 * 1024 * 1024),
      })),
    },
  ])('rejects invalid image options before a request %#', async (override) => {
    await expect(
      client().createImages('one', {
        ...imageInput,
        ...override,
      } as ImageCreationInput),
    ).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  test('submits an asynchronous video task and queries its encoded ID', async () => {
    response = () => Response.json({ request_id: 'job id' })
    const api = client()
    expect(await api.createVideo('one', videoInput)).toMatchObject({
      requestId: 'job id',
      status: 'pending',
    })
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      model: 'xai/grok-imagine-video-1.5',
      prompt: 'A moving boat',
      duration: 8,
      aspect_ratio: '16:9',
      resolution: '720p',
      generate_audio: true,
    })
    response = () =>
      Response.json({
        status: 'done',
        video: { url: 'https://vidgen.x.ai/result.mp4' },
      })
    expect(await api.getVideo('two', 'job id')).toMatchObject({
      status: 'done',
      url: 'https://vidgen.x.ai/result.mp4',
    })
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://[::1]:5151/v1/videos/job%20id',
    )
  })
  test('sends a first frame as a data URL without an ignored aspect ratio', async () => {
    response = () => Response.json({ request_id: 'job' })
    await client().createVideo('one', { ...videoInput, image })
    const payload: unknown = JSON.parse(
      fetchMock.mock.calls[0][1]?.body as string,
    )
    expect(payload).toHaveProperty(
      'image.url',
      'data:image/png;base64,iVBORw==',
    )
    expect(payload).not.toHaveProperty('aspect_ratio')
  })
  test('allows a first-frame video without a prompt', async () => {
    response = () => Response.json({ request_id: 'job' })
    expect(
      await client().createVideo('one', {
        ...videoInput,
        prompt: '  ',
        image,
      }),
    ).toMatchObject({ status: 'pending', requestId: 'job' })
    const payload: unknown = JSON.parse(
      fetchMock.mock.calls[0][1]?.body as string,
    )
    expect(payload).not.toHaveProperty('prompt')
    expect(payload).toHaveProperty(
      'image.url',
      'data:image/png;base64,iVBORw==',
    )
  })
  test.each([
    { duration: 0 },
    { duration: 16 },
    { duration: 1.1 },
    { resolution: '4k' },
    { aspectRatio: 'bad' },
    { prompt: '' },
    { generateAudio: 'false' },
  ])('rejects invalid video options %#', async (override) => {
    await expect(
      client().createVideo('one', {
        ...videoInput,
        ...override,
      } as VideoCreationInput),
    ).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  test.each(['', ' ', '.', '..', '../job', 'a/b', 'a\\b'])(
    'rejects invalid job IDs %s',
    async (id) => {
      await expect(client().getVideo('one', id)).rejects.toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )
  test('rejects a pending submission with no request ID', async () => {
    response = () => Response.json({ status: 'pending' })
    await expect(client().createVideo('one', videoInput)).rejects.toThrow(
      'No video request ID',
    )
  })
  test.each([
    [{ error: { message: 'Provider disabled' } }, 'Provider disabled'],
    [{ error: 'Quota exhausted' }, 'Quota exhausted'],
    [{ message: 'Invalid options' }, 'Invalid options'],
    [{ detail: 'Unsupported content type' }, 'Unsupported content type'],
    [{ detail: { message: 'Invalid detail type' } }, 'HTTP 400'],
    [
      { error: { message: 'Primary error' }, detail: 'Other detail' },
      'Primary error',
    ],
    [{}, 'HTTP 400'],
  ] as const)(
    'surfaces structured upstream errors %#',
    async (body, expected) => {
      response = () => Response.json(body, { status: 400 })
      await expect(client().createImages('one', imageInput)).rejects.toThrow(
        expected,
      )
    },
  )
  test('cancels active calls, rejects duplicate IDs and releases the ID afterward', async () => {
    const api = client()
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          )
          entered()
        }),
    )
    const pending = api.createImages('one', imageInput)
    await ready
    await expect(api.createImages('one', imageInput)).rejects.toThrow(
      'duplicate',
    )
    api.cancel('one')
    await expect(pending).rejects.toThrow('cancelled')
    api.cancel('missing')
    expect(await api.createImages('one', imageInput)).toHaveLength(1)
  })
  test('cancels a request while auth is loading and prevents any fetch', async () => {
    let complete!: (headers: undefined) => void
    const api = createMediaStudioClient({
      getBaseUrl: () => 'http://localhost',
      getHeaders: () =>
        new Promise((resolve) => {
          complete = resolve
        }),
      fetch: fetchMock,
    })
    const pending = api.createImages('one', imageInput)
    api.cancelAll()
    complete(undefined)
    await expect(pending).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  test('propagates server-stopped and network errors', async () => {
    const api = createMediaStudioClient({
      getBaseUrl: () => {
        throw new Error('stopped')
      },
      getHeaders: () => Promise.resolve(undefined),
      fetch: fetchMock,
    })
    await expect(api.createImages('one', imageInput)).rejects.toThrow('stopped')
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(client().createImages('one', imageInput)).rejects.toThrow(
      'offline',
    )
  })
})

describe('media responses', () => {
  test.each([
    ['https://imgen.x.ai/a.jpeg?token=abc', 'jpeg'],
    ['https://imgen.x.ai/a.webp', 'webp'],
    ['https://imgen.x.ai/a.PNG', 'png'],
    ['https://imgen.x.ai/opaque', 'png'],
    ['data:image/gif;base64,R0lGODlh', 'gif'],
  ])('infers the saved extension %s', (url, extension) =>
    expect(mediaFileExtension({ kind: 'image', url })).toBe(extension),
  )
  test('uses mp4 for videos', () =>
    expect(
      mediaFileExtension({ kind: 'video', url: 'https://vidgen.x.ai/clip' }),
    ).toBe('mp4'))
  test.each([
    ['iVBORw==', 'png'],
    ['/9j/AA==', 'jpeg'],
    ['UklGRgAA', 'webp'],
    ['R0lGODlh', 'gif'],
  ])('detects output type %s', (base64, mime) => {
    expect(
      parseCreatedImages({
        data: [{ b64_json: base64, revised_prompt: 'Adjusted prompt' }],
      })[0],
    ).toEqual({
      url: `data:image/${mime};base64,${base64}`,
      revisedPrompt: 'Adjusted prompt',
    })
  })
  test('accepts a URL response and output format metadata', () => {
    expect(
      parseCreatedImages({ data: [{ url: 'https://imgen.x.ai/image' }] })[0]
        .url,
    ).toBe('https://imgen.x.ai/image')
    expect(
      parseCreatedImages({
        output_format: 'webp',
        data: [{ b64_json: 'AA==' }],
      })[0].url,
    ).toStartWith('data:image/webp;')
  })
  test.each(
    [
      null,
      [],
      {},
      { data: [] },
      { data: [{}] },
      { data: [{ url: 'file:///etc/passwd' }] },
      { data: [{ b64_json: 'invalid-characters' }] },
    ].map((value) => ({ value })),
  )('rejects invalid images %#', ({ value }) =>
    expect(() => parseCreatedImages(value)).toThrow(),
  )
  test.each(['pending', 'processing'])(
    'normalizes %s video progress',
    (status) =>
      expect(parseVideoResult({ status })).toMatchObject({ status: 'pending' }),
  )
  test.each(['failed', 'expired'])(
    'preserves terminal status %s and error',
    (status) =>
      expect(
        parseVideoResult({ status, error: { message: 'Not available' } }),
      ).toMatchObject({ status, error: 'Not available' }),
  )
  test('respects video moderation', () =>
    expect(
      parseVideoResult({
        status: 'done',
        video: { url: 'https://example.com/a.mp4', respect_moderation: false },
      }),
    ).toMatchObject({ status: 'failed' }))
  test.each([
    null,
    {},
    { status: 'weird' },
    { status: 'done' },
    { status: 'done', video: { url: 'javascript:alert(1)' } },
  ])('rejects malformed video response %#', (value) =>
    expect(() => parseVideoResult(value)).toThrow(),
  )
  test.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html;base64,AA==',
    'https://name:password@example.com/a',
    '',
  ])('rejects unsafe media URLs %s', (url) =>
    expect(() => validateMediaUrl(url, 'image')).toThrow(),
  )
})

describe('saving media', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'media-save-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  test('saves data URLs and atomically replaces the selected file', async () => {
    const filePath = path.join(directory, 'image.png')
    await writeFile(filePath, 'previous')
    const unsupportedDataFetch = mock(() =>
      Promise.reject(new Error('Electron does not support data URLs')),
    )
    await saveMediaFile(
      { kind: 'image', url: 'data:image/png;base64,iVBORw==' },
      filePath,
      unsupportedDataFetch,
    )
    expect(unsupportedDataFetch).not.toHaveBeenCalled()
    expect(Array.from(await readFile(filePath))).toEqual(
      Array.from(image.bytes),
    )
    expect(await readdir(directory)).toEqual(['image.png'])
  })
  test('downloads without gateway credentials', async () => {
    const download = mock((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response('video-content')),
    )
    await saveMediaFile(
      { kind: 'video', url: 'https://vidgen.x.ai/a.mp4' },
      path.join(directory, 'video.mp4'),
      download,
    )
    expect(await readFile(path.join(directory, 'video.mp4'), 'utf8')).toBe(
      'video-content',
    )
    expect(download.mock.calls[0][1]).not.toHaveProperty('headers')
  })
  test('leaves an existing file intact and cleans partial downloads on failure', async () => {
    const filePath = path.join(directory, 'video.mp4')
    await writeFile(filePath, 'previous')
    const download = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]))
              controller.error(new Error('broken stream'))
            },
          }),
        ),
      )
    await expect(
      saveMediaFile(
        { kind: 'video', url: 'https://vidgen.x.ai/a.mp4' },
        filePath,
        download,
      ),
    ).rejects.toThrow('broken stream')
    expect(await readFile(filePath, 'utf8')).toBe('previous')
    expect(await readdir(directory)).toEqual(['video.mp4'])
  })
  test('surfaces failed downloads and rejects invalid URL schemes', async () => {
    const filePath = path.join(directory, 'video.mp4')
    await expect(
      saveMediaFile(
        { kind: 'video', url: 'https://example.com/a.mp4' },
        filePath,
        () => Promise.resolve(new Response(null, { status: 404 })),
      ),
    ).rejects.toThrow('HTTP 404')
    await expect(
      saveMediaFile(
        { kind: 'video', url: 'data:video/mp4;base64,AA==' },
        filePath,
      ),
    ).rejects.toThrow()
  })
})
