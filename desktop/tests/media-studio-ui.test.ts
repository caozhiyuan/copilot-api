import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import MediaStudioPage from '../src/pages/MediaStudioPage'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import type {
  CreatedImage,
  ImageCreationInput,
  VideoCreationInput,
  VideoCreationResult,
} from '../src/types/media'

let win: Window
let root: Root
let container: HTMLDivElement
const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
let createImages = mock(
  (_id: string, _input: ImageCreationInput): Promise<CreatedImage[]> =>
    Promise.resolve([
      {
        url: 'data:image/png;base64,iVBORw==',
        revisedPrompt: 'Revised image prompt',
      },
    ]),
)
let createVideo = mock(
  (_id: string, _input: VideoCreationInput): Promise<VideoCreationResult> =>
    Promise.resolve({ status: 'pending', requestId: 'video-job' }),
)
let getVideo = mock(
  (_id: string, _requestId: string): Promise<VideoCreationResult> =>
    Promise.resolve({ status: 'done', url: 'https://vidgen.x.ai/clip.mp4' }),
)
let cancel = mock((_id: string): Promise<void> => Promise.resolve())
let save = mock((): Promise<boolean> => Promise.resolve(true))
let fetchModels = mock((): Promise<unknown> =>
  Promise.resolve({
    data: [{ id: 'codex/gpt-image-2' }],
  }),
)
let timers: ReturnType<typeof spyOn<typeof globalThis, 'setTimeout'>>

beforeEach(async () => {
  win = new Window({ url: 'http://localhost' })
  for (const [name, value] of Object.entries({
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    Event: win.Event,
    KeyboardEvent: win.KeyboardEvent,
    MouseEvent: win.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    })
  }
  createImages = mock((_id, _input) =>
    Promise.resolve([
      {
        url: 'data:image/png;base64,iVBORw==',
        revisedPrompt: 'Revised image prompt',
      },
    ]),
  )
  createVideo = mock((_id, _input) =>
    Promise.resolve({ status: 'pending', requestId: 'video-job' }),
  )
  getVideo = mock((_id, _requestId) =>
    Promise.resolve({ status: 'done', url: 'https://vidgen.x.ai/clip.mp4' }),
  )
  cancel = mock((_id) => Promise.resolve())
  save = mock(() => Promise.resolve(true))
  fetchModels = mock(() =>
    Promise.resolve({ data: [{ id: 'codex/gpt-image-2' }] }),
  )
  Object.defineProperty(win, 'electronAPI', {
    configurable: true,
    value: {
      createImages,
      createVideo,
      getVideo,
      cancelMediaRequest: cancel,
      saveMedia: save,
      fetchModels,
    },
  })
  timers = spyOn(globalThis, 'setTimeout')
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  timers.mockRestore()
  await win.happyDOM.close()
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  previousGlobals.clear()
})

async function render(serverRunning = true) {
  await act(async () =>
    root.render(
      createElement(LanguageProvider, {
        children: createElement(MediaStudioPage, { serverRunning }),
      }),
    ),
  )
}
function button(text: string) {
  const result = [...container.querySelectorAll('button')].find(
    (el) => el.textContent === text,
  )
  if (!result) throw new Error('Missing button: ' + text)
  return result
}
async function click(text: string) {
  await act(async () => button(text).click())
}
async function change(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  await act(async () => {
    const prototype =
      element.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype
      : element.tagName === 'SELECT' ? win.HTMLSelectElement.prototype
      : win.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
      element,
      value,
    )
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function prompt(value = 'A boat on the river') {
  await change(container.querySelector('textarea')!, value)
}
function select(index: number) {
  return container.querySelectorAll('select')[index]
}
function number(index: number) {
  return container.querySelectorAll<HTMLInputElement>('input[type=number]')[
    index
  ]
}
async function upload(files: File[]) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: files })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function checkProgress() {
  const call = timers.mock.calls.findLastIndex(([, delay]) => delay === 5000)
  if (call < 0) throw new Error('No progress check scheduled')
  const result = timers.mock.results[call]
  if (result.type === 'return') clearTimeout(result.value)
  await act(async () => {
    timers.mock.calls[call][0]()
    await Promise.resolve()
  })
}
const file = (name = 'source.png') =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })

describe('media creation page', () => {
  test.each<{ ids: string[]; expected: string }>([
    {
      ids: [
        'xai/grok-imagine-image-2.0',
        'github-copilot/gpt-image-2.5-flare',
        'codex/gpt-image-2',
      ],
      expected: 'codex/gpt-image-2',
    },
    {
      ids: ['xai/grok-imagine-image-2.0', 'github-copilot/gpt-image-2.5-flare'],
      expected: 'github-copilot/gpt-image-2.5-flare',
    },
    {
      ids: ['xai/grok-imagine-image-2.0'],
      expected: 'xai/grok-imagine-image-2.0',
    },
    { ids: [], expected: '' },
  ])(
    'selects the available default image model $expected',
    async ({ ids, expected }) => {
      fetchModels.mockResolvedValueOnce({ data: ids.map((id) => ({ id })) })
      await render()
      const model =
        container.querySelector<HTMLInputElement>('input:not([type])')!
      expect(model.value).toBe(expected)
      await prompt()
      await click('Create')
      expect(createImages.mock.calls[0][1]).toMatchObject({
        provider: 'default',
        model: expected,
      })
    },
  )

  test('keeps a user model when discovery finishes later', async () => {
    let finish: ((value: unknown) => void) | undefined
    fetchModels.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    await render()
    const model =
      container.querySelector<HTMLInputElement>('input:not([type])')!
    await change(model, 'github-copilot/gpt-image-2.5-flare')
    await act(async () => {
      finish?.({ data: [{ id: 'codex/gpt-image-2' }] })
      await Promise.resolve()
    })
    expect(model.value).toBe('github-copilot/gpt-image-2.5-flare')
  })

  test('allows gateway defaults when model discovery fails', async () => {
    fetchModels.mockRejectedValueOnce(new Error('discovery unavailable'))
    await render()
    await prompt()
    await click('Create')
    expect(createImages.mock.calls[0][1]).toMatchObject({
      provider: 'default',
      model: '',
    })
  })

  test.each([
    ['Generate image', '1', '2'],
    ['Edit image', '1', '3'],
    ['Generate video', '8', '12'],
  ])(
    'allows clearing and retyping numeric options in %s',
    async (mode, initial, value) => {
      await render()
      await click(mode)
      const input = number(0)
      expect(input.value).toBe(initial)

      await act(async () => input.focus())
      await change(input, '')
      expect(input.value).toBe('')
      await act(async () => input.blur())
      expect(input.value).toBe('')
      expect(input.checkValidity()).toBe(false)

      await act(async () => input.focus())
      for (const digit of value) await change(input, input.value + digit)
      expect(input.value).toBe(value)
      await act(async () => input.blur())
      expect(input.checkValidity()).toBe(true)

      await act(async () => input.focus())
      await change(input, `0${value}`)
      await act(async () => input.blur())
      expect(input.value).toBe(value)
    },
  )

  test('keeps separate prompt drafts and submits the active mode from the workspace editor', async () => {
    await render()
    const form = container.querySelector('form')!
    const editor = container.querySelector('textarea')!
    expect(editor.closest('form')).toBeNull()
    expect(editor.form).toBe(form)
    await prompt('Generate a boat')
    await click('Edit image')
    expect(container.querySelector('textarea')?.value).toBe('')
    await prompt('Replace the background')
    await upload([file()])
    await click('Create')
    expect(createImages.mock.calls[0][1]).toMatchObject({
      mode: 'edit',
      prompt: 'Replace the background',
    })
    await click('Generate video')
    expect(container.querySelector('textarea')?.value).toBe('')
    await prompt('Animate the boat')
    await click('Generate image')
    expect(container.querySelector('textarea')?.value).toBe('Generate a boat')
    await click('Create')
    expect(createImages.mock.calls[1][1]).toMatchObject({
      mode: 'generate',
      prompt: 'Generate a boat',
    })
    await click('Edit image')
    expect(container.querySelector('textarea')?.value).toBe(
      'Replace the background',
    )
    await click('Generate video')
    expect(container.querySelector('textarea')?.value).toBe('Animate the boat')
  })
  test('requires the service and a prompt', async () => {
    await render(false)
    expect(container.textContent).toContain('Start the server')
    await prompt()
    expect(button('Create').disabled).toBe(true)
    await render(true)
    expect(button('Create').disabled).toBe(false)
    await prompt(' ')
    expect(button('Create').disabled).toBe(true)
  })
  test('shows the empty results panel before the first generation', async () => {
    await render()
    const results = container.querySelector('section[aria-label="Results"]')
    expect(results).not.toBeNull()
    expect(results?.textContent).toContain(
      'Your images and videos will appear here.',
    )
  })
  test('generates, previews and saves images with the selected options', async () => {
    await render()
    await prompt()
    expect(container.textContent).not.toContain('Provider')
    await change(select(0), '1536x1024')
    await change(select(1), 'high')
    await change(number(0), '2')
    await click('Create')
    expect(createImages.mock.calls[0][1]).toMatchObject({
      provider: 'default',
      model: 'codex/gpt-image-2',
      mode: 'generate',
      size: '1536x1024',
      quality: 'high',
      n: 2,
    })
    expect(
      container.querySelector('figure img')?.getAttribute('src'),
    ).toStartWith('data:image/png')
    expect(container.textContent).toContain('Revised image prompt')
    await click('Save')
    expect(save).toHaveBeenCalledWith({
      kind: 'image',
      url: 'data:image/png;base64,iVBORw==',
    })
    expect(container.textContent).toContain('Saved')
  })
  test('submits with Enter and keeps Shift+Enter for a newline', async () => {
    await render()
    await prompt()
    const editor = container.querySelector('textarea')!
    await act(async () =>
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    )
    expect(createImages).not.toHaveBeenCalled()
    await act(async () => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      )
      await Promise.resolve()
    })
    expect(createImages).toHaveBeenCalledTimes(1)
  })
  test('replaces image results when a video request is accepted', async () => {
    await render()
    await prompt()
    await click('Create')
    expect(container.querySelectorAll('figure')).toHaveLength(1)
    await click('Generate video')
    await prompt()
    await click('Create')
    expect(container.querySelectorAll('figure')).toHaveLength(0)
    expect(container.textContent).toContain('video-job')
  })
  test('replaces a completed video when a new image result arrives', async () => {
    await render()
    await click('Generate video')
    await prompt()
    await click('Create')
    await checkProgress()
    expect(container.querySelector('video')).not.toBeNull()
    await click('Generate image')
    await prompt()
    await click('Create')
    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelectorAll('figure')).toHaveLength(1)
  })
  test('blocks submissions from another mode while a video is pending', async () => {
    await render()
    await click('Generate video')
    await prompt()
    await click('Create')
    await click('Generate image')
    await prompt('A replacement image')
    expect(button('Create').disabled).toBe(true)
  })
  test('previews the original image and closes the viewer', async () => {
    await render()
    await prompt()
    await click('Create')
    await click('View original')
    const dialog = container.querySelector('[role=dialog]')!
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,iVBORw==',
    )
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Close preview"]')!
        .click(),
    )
    expect(container.querySelector('[role=dialog]')).toBeNull()
    await click('View original')
    await act(async () =>
      win.document.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Escape' }),
      ),
    )
    expect(container.querySelector('[role=dialog]')).toBeNull()
  })
  test('routes custom model aliases through Gateway default', async () => {
    await render()
    await prompt()
    const model =
      container.querySelector<HTMLInputElement>('input:not([type])')!
    expect(model.value).toBe('codex/gpt-image-2')
    await change(model, 'github-copilot/gpt-image-2.5-flare')
    await click('Create')
    expect(createImages.mock.calls[0][1]).toMatchObject({
      provider: 'default',
      model: 'github-copilot/gpt-image-2.5-flare',
    })
  })
  test('requires an edit image, uploads bytes and removes previews', async () => {
    await render()
    await click('Edit image')
    await prompt('Replace the background')
    expect(button('Create').disabled).toBe(true)
    await upload([file()])
    expect(container.querySelector('img')?.getAttribute('alt')).toBe(
      'source.png',
    )
    await click('Create')
    expect(createImages.mock.calls[0][1]).toMatchObject({
      mode: 'edit',
      provider: 'default',
      images: [
        {
          name: 'source.png',
          type: 'image/png',
          bytes: new Uint8Array([137, 80, 78, 71]),
        },
      ],
    })
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Remove: source.png"]',
        )!
        .click(),
    )
    expect(button('Create').disabled).toBe(true)
  })
  test('rejects unsupported files and excess upload count', async () => {
    await render()
    await click('Edit image')
    await upload([new File(['text'], 'a.txt', { type: 'text/plain' })])
    expect(container.querySelector('[role=alert]')?.textContent).toContain(
      'PNG',
    )
    await upload(Array.from({ length: 6 }, (_, i) => file(`${i}.png`)))
    expect(container.querySelectorAll('img')).toHaveLength(0)
    await upload([file()])
    expect(container.querySelector('[role=alert]')).toBeNull()
  })
  test('keeps edit uploads separate from a video first frame', async () => {
    await render()
    await click('Edit image')
    await upload([file('edit.png')])
    await click('Generate video')
    expect(container.querySelectorAll('img')).toHaveLength(0)
    await upload([file('frame.png')])
    await prompt()
    await change(number(0), '12')
    await change(select(0), '1080p')
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('input[type=checkbox]')!
        .click(),
    )
    await click('Create')
    expect(createVideo.mock.calls[0][1]).toMatchObject({
      duration: 12,
      resolution: '1080p',
      generateAudio: false,
      image: { name: 'frame.png' },
    })
    await click('Edit image')
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('edit.png')
  })
  test('allows a first-frame video without a prompt', async () => {
    await render()
    await click('Generate video')
    await upload([file('frame.png')])
    expect(button('Create').disabled).toBe(false)
    await click('Create')
    expect(createVideo.mock.calls[0][1]).toMatchObject({
      prompt: '',
      image: { name: 'frame.png' },
    })
  })
  test('polls asynchronous video, previews completion and saves the video', async () => {
    await render()
    await click('Generate video')
    await prompt()
    await change(select(1), '9:16')
    await click('Create')
    expect(createVideo.mock.calls[0][1].aspectRatio).toBe('9:16')
    expect(container.textContent).toContain('video-job')
    expect(button('Create').disabled).toBe(true)
    await checkProgress()
    expect(getVideo.mock.calls[0][1]).toBe('video-job')
    expect(container.querySelector('video')?.getAttribute('src')).toBe(
      'https://vidgen.x.ai/clip.mp4',
    )
    await click('Save')
    expect(save).toHaveBeenCalledWith({
      kind: 'video',
      url: 'https://vidgen.x.ai/clip.mp4',
    })
    expect(button('Create').disabled).toBe(false)
  })
  test('pauses and resumes checks without creating another job', async () => {
    await render()
    await click('Generate video')
    await prompt()
    await click('Create')
    await click('Pause checks')
    expect(container.textContent).toContain('Progress checks paused')
    await click('Resume checks')
    await checkProgress()
    expect(createVideo).toHaveBeenCalledTimes(1)
    expect(getVideo).toHaveBeenCalledTimes(1)
  })
  test('recovers from a failed query by stopping tracking and creating a new video', async () => {
    getVideo.mockRejectedValueOnce(new Error('HTTP 404'))
    await render()
    await click('Generate video')
    await prompt()
    await click('Create')
    await checkProgress()
    expect(container.textContent).toContain('HTTP 404')
    await click('Stop tracking')
    expect(button('Create').disabled).toBe(false)
    await click('Create')
    expect(createVideo).toHaveBeenCalledTimes(2)
  })
  test('surfaces a terminal video failure', async () => {
    getVideo.mockResolvedValueOnce({
      status: 'failed',
      error: 'Video filtered',
    })
    await render()
    await click('Generate video')
    await prompt()
    await click('Create')
    await checkProgress()
    expect(container.textContent).toContain('Video filtered')
    expect(button('Create').disabled).toBe(false)
  })
  test('displays submit and save failures and permits retry', async () => {
    createImages.mockRejectedValueOnce(new Error('Provider disabled'))
    await render()
    await prompt()
    await click('Create')
    expect(container.textContent).toContain('Provider disabled')
    await click('Create')
    save.mockRejectedValueOnce(new Error('Disk full'))
    await click('Save')
    expect(container.textContent).toContain('Disk full')
    save.mockResolvedValueOnce(false)
    await click('Save')
    expect(container.textContent).not.toContain('Saved')
  })
  test('stops waiting, ignores late image results and allows a new submission', async () => {
    const pending = Promise.withResolvers<CreatedImage[]>()
    createImages.mockReturnValueOnce(pending.promise)
    await render()
    await prompt()
    await click('Create')
    await click('Stop waiting')
    expect(cancel).toHaveBeenCalledWith(createImages.mock.calls[0][0])
    await act(async () =>
      pending.resolve([{ url: 'https://example.com/late.png' }]),
    )
    expect(container.querySelectorAll('figure')).toHaveLength(0)
    await click('Create')
    expect(container.querySelectorAll('figure')).toHaveLength(1)
  })
  test('stops checks when the server stops and preserves the job for resume', async () => {
    await render()
    await click('Generate video')
    await prompt()
    await click('Create')
    await render(false)
    expect(button('Resume checks').disabled).toBe(true)
    expect(container.textContent).toContain('video-job')
    await render(true)
    await click('Resume checks')
    await checkProgress()
    expect(getVideo).toHaveBeenCalledTimes(1)
  })
  test('ignores an in-flight poll after tracking is stopped', async () => {
    const pending = Promise.withResolvers<VideoCreationResult>()
    getVideo.mockReturnValueOnce(pending.promise)
    await render()
    await click('Generate video')
    await prompt()
    await click('Create')
    await checkProgress()
    await click('Stop tracking')
    expect(cancel).toHaveBeenCalledWith(getVideo.mock.calls[0][0])
    await act(async () =>
      pending.resolve({ status: 'done', url: 'https://example.com/late.mp4' }),
    )
    expect(container.querySelector('video')).toBeNull()
  })
  test('unmount cancels an outstanding submission', async () => {
    createImages.mockReturnValueOnce(new Promise(() => {}))
    await render()
    await prompt()
    await click('Create')
    await act(async () => root.render(null))
    expect(cancel).toHaveBeenCalledWith(createImages.mock.calls[0][0])
  })
})
