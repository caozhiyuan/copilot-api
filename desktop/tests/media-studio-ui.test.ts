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
  Object.defineProperty(win, 'electronAPI', {
    configurable: true,
    value: {
      createImages,
      createVideo,
      getVideo,
      cancelMediaRequest: cancel,
      saveMedia: save,
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
    ;(timers.mock.calls[call][0] as () => void)()
    await Promise.resolve()
  })
}
const file = (name = 'source.png') =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })

describe('media creation page', () => {
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
  test('generates, previews and saves images with the selected options', async () => {
    await render()
    await prompt()
    await change(select(0), 'codex')
    await change(select(1), '1536x1024')
    await change(select(2), 'high')
    await change(number(0), '2')
    await click('Create')
    expect(createImages.mock.calls[0][1]).toMatchObject({
      provider: 'codex',
      model: 'gpt-image-2',
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
  test('changes the provider default model and permits a custom model alias', async () => {
    await render()
    await prompt()
    await change(select(0), 'xai')
    const model =
      container.querySelector<HTMLInputElement>('input:not([type])')!
    expect(model.value).toBe('grok-imagine-image-2.0')
    await change(model, 'custom-image-model')
    await click('Create')
    expect(createImages.mock.calls[0][1]).toMatchObject({
      provider: 'xai',
      model: 'custom-image-model',
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
