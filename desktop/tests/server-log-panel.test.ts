import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

import ServerLogPanel from '../src/components/ServerLogPanel'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import { LOG_UPDATE_INTERVAL_MS } from '../shared/log-buffer'
import type { ServerLogRecord } from '../src/types/ipc'

let win: Window
let root: Root
let container: HTMLDivElement
let logListener: ((log: ServerLogRecord) => void) | null
const previousGlobals = new Map<string, PropertyDescriptor | undefined>()

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(async () => {
  win = new Window({ url: 'http://localhost' })
  const globals: Record<string, unknown> = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    Event: win.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [name, value] of Object.entries(globals)) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    })
  }

  logListener = null
  Object.defineProperty(win, 'electronAPI', {
    configurable: true,
    value: {
      getLogs: () => Promise.resolve([]),
      clearLogs: () => Promise.resolve(0),
      onServerLog: (callback: (log: ServerLogRecord) => void) => {
        logListener = callback
        return () => {}
      },
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  await win.happyDOM.close()
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  previousGlobals.clear()
})

async function renderPanel(variant: 'failure' | 'page') {
  await act(async () => {
    root.render(
      createElement(LanguageProvider, {
        children: createElement(ServerLogPanel, { variant }),
      }),
    )
  })
  await act(async () => {})
}

function findClearButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (item) => item.textContent === 'Clear',
  )
  if (!button) throw new Error('Missing clear button')
  return button
}

async function reopenPanel(variant: 'failure' | 'page') {
  await act(async () => {
    root.unmount()
  })
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container)
  await renderPanel(variant)
}

describe('server log panel', () => {
  test('replays history, batches live logs, and clears stored and displayed logs', async () => {
    let storedLogs: Array<ServerLogRecord> = [
      { sequence: 1, text: 'history log' },
      { sequence: 2, text: '' },
      { sequence: 3, text: 'another history log' },
    ]
    window.electronAPI.getLogs = mock(() =>
      Promise.resolve(storedLogs.map((log) => ({ ...log }))),
    )
    window.electronAPI.clearLogs = mock(() => {
      storedLogs = []
      return Promise.resolve(5)
    })
    await renderPanel('page')
    expect(container.textContent).toContain('history log')

    await act(async () => {
      logListener?.({ sequence: 4, text: 'live one' })
      logListener?.({ sequence: 5, text: 'live two' })
      await wait(LOG_UPDATE_INTERVAL_MS + 50)
    })
    expect(container.textContent).toContain('live one')
    expect(container.textContent).toContain('live two')

    await act(async () => {
      findClearButton().click()
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain('history log')
    expect(container.textContent).not.toContain('live one')
    expect(container.textContent).not.toContain('live two')

    await reopenPanel('page')
    expect(container.textContent).not.toContain('history log')
    expect(container.textContent).not.toContain('another history log')
    expect(container.textContent).not.toContain('live one')
  })

  test('keeps a log emitted after the cleared sequence', async () => {
    let storedLogs: Array<ServerLogRecord> = [
      { sequence: 1, text: 'history log' },
    ]
    let resolveClear: ((watermark: number) => void) | undefined
    window.electronAPI.getLogs = mock(() =>
      Promise.resolve(storedLogs.map((log) => ({ ...log }))),
    )
    window.electronAPI.clearLogs = mock(
      () =>
        new Promise<number>((resolve) => {
          storedLogs = []
          resolveClear = resolve
        }),
    )
    await renderPanel('page')

    await act(async () => {
      findClearButton().click()
      storedLogs = [{ sequence: 2, text: 'after clear' }]
      logListener?.({ sequence: 2, text: 'after clear' })
      resolveClear?.(1)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('after clear')
    expect(container.textContent).not.toContain('history log')

    await reopenPanel('page')
    expect(container.textContent).toContain('after clear')
    expect(container.textContent).not.toContain('history log')
  })

  test('keeps the current page when clearing stored logs fails', async () => {
    window.electronAPI.getLogs = mock(() =>
      Promise.resolve([{ sequence: 1, text: 'history log' }]),
    )
    window.electronAPI.clearLogs = mock(() =>
      Promise.reject(new Error('clear failed')),
    )
    await renderPanel('page')

    await act(async () => {
      findClearButton().click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('history log')
  })

  test('uses sequence watermarks without dropping distinct identical logs', async () => {
    let resolveHistory: ((logs: Array<ServerLogRecord>) => void) | undefined
    window.electronAPI.getLogs = mock(
      () =>
        new Promise<Array<ServerLogRecord>>((resolve) => {
          resolveHistory = resolve
        }),
    )
    await renderPanel('failure')

    await act(async () => {
      logListener?.({ sequence: 2, text: 'shared log' })
      logListener?.({ sequence: 3, text: 'new live log' })
      logListener?.({ sequence: 4, text: 'shared log' })
      resolveHistory?.([
        { sequence: 1, text: 'history log' },
        { sequence: 2, text: 'shared log' },
      ])
      await Promise.resolve()
    })

    expect(container.textContent?.match(/shared log/g)).toHaveLength(2)
    expect(container.textContent).toContain('new live log')
  })

  test('keeps live entries queued when replay loading fails', async () => {
    window.electronAPI.getLogs = mock(() =>
      Promise.reject(new Error('replay unavailable')),
    )
    await renderPanel('page')

    await act(async () => {
      logListener?.({ sequence: 1, text: 'live after subscribe' })
      await wait(LOG_UPDATE_INTERVAL_MS + 50)
    })

    expect(container.textContent).toContain('live after subscribe')
  })

  test('smooth-pins a short gap and snaps when a glide is still in flight', async () => {
    await renderPanel('page')
    const view = installScroller({ scrollHeight: 300, clientHeight: 200 })

    await publishLog(1, 'short gap')
    expect(view.pins.at(-1)).toEqual({ top: 100, behavior: 'smooth' })
    expect(view.node.scrollTop).toBe(0)
    expect(view.node.style.overflowAnchor).toBe('none')
    expect(
      view.node.querySelector('[data-log-sequence="1"]')?.getAttribute('style'),
    ).toContain('overflow-anchor')

    view.metrics.scrollHeight = 360
    await publishLog(2, 'while gliding')
    expect(view.pins.at(-1)).toEqual({ top: 160, behavior: 'auto' })
    expect(view.node.scrollTop).toBe(160)
  })

  test('does not restart a glide whose target has not moved', async () => {
    await renderPanel('page')
    const view = installScroller({ scrollHeight: 300, clientHeight: 200 })

    await publishLog(1, 'first')
    const pinsBefore = view.pins.length
    await publishLog(2, 'same height')

    expect(view.pins.length).toBe(pinsBefore)
  })

  test('lets the reader scroll up and resumes inside the follow band', async () => {
    await renderPanel('page')
    const view = installScroller({ scrollHeight: 1000, clientHeight: 200 })
    await publishLog(1, 'pinned')
    expect(view.node.scrollTop).toBe(800)

    await userScroll(view.node, 600)
    view.metrics.scrollHeight = 1300
    await publishLog(2, 'while reading')
    expect(view.node.scrollTop).toBe(600)

    await userScroll(view.node, 1050)
    expect(view.pins.at(-1)).toEqual({ top: 1100, behavior: 'smooth' })
  })

  test('keeps following when eviction clamps the viewport onto the bottom', async () => {
    await renderPanel('page')
    const view = installScroller({ scrollHeight: 1000, clientHeight: 200 })
    await publishLog(1, 'pinned')

    view.metrics.scrollHeight = 900
    await userScroll(view.node, 700)
    view.metrics.scrollHeight = 1100
    await publishLog(2, 'still pinned')

    expect(view.node.scrollTop).toBe(900)
  })

  test('cancels an in-flight glide when the reader scrolls away', async () => {
    await renderPanel('page')
    const view = installScroller({ scrollHeight: 350, clientHeight: 200 })
    view.node.scrollTop = 50

    await publishLog(1, 'gliding')
    expect(view.pins.at(-1)).toEqual({ top: 150, behavior: 'smooth' })

    await userScroll(view.node, 0)
    view.metrics.scrollHeight = 800
    await publishLog(2, 'should stay put')

    expect(view.node.scrollTop).toBe(0)
  })

  test('pins again after clear once the reader had scrolled away', async () => {
    await renderPanel('page')
    const view = installScroller({ scrollHeight: 1000, clientHeight: 200 })
    await publishLog(1, 'pinned')
    await userScroll(view.node, 100)

    await act(async () => {
      findClearButton().click()
      await Promise.resolve()
    })

    expect(view.node.scrollTop).toBe(800)
  })

  test('pins the failure log with the same follow behavior', async () => {
    await renderPanel('failure')
    const view = installScroller({ scrollHeight: 1000, clientHeight: 200 })
    await publishLog(1, 'failure log')

    expect(view.node.className).toContain('max-h-60')
    expect(view.node.scrollTop).toBe(800)
    expect(view.node.style.overflowAnchor).toBe('none')
  })

  test('snaps when the reader prefers reduced motion', async () => {
    const matchMedia = window.matchMedia.bind(window)
    window.matchMedia = (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })
    try {
      await renderPanel('page')
      const view = installScroller({ scrollHeight: 300, clientHeight: 200 })
      await publishLog(1, 'reduced motion')
      expect(view.pins.at(-1)).toEqual({ top: 100, behavior: 'auto' })
      expect(view.node.scrollTop).toBe(100)
    } finally {
      window.matchMedia = matchMedia
    }
  })

  test('keeps the visible row in place when older entries disappear', async () => {
    await renderPanel('page')
    const view = installScroller({ scrollHeight: 1000, clientHeight: 200 })
    await publishLog(1, 'anchor row')
    await userScroll(view.node, 200)

    const row = view.node.querySelector<HTMLElement>('[data-log-sequence="1"]')
    if (!row) throw new Error('Missing anchored row')
    let rowTop = 40
    stubAnchorGeometry(view.node, row, () => rowTop)
    await userScroll(view.node, 200)

    rowTop = 10
    await publishLog(2, 'appended while reading')

    expect(view.node.scrollTop).toBe(170)
    expect(view.pins.at(-1)).toEqual({ top: 170, behavior: 'auto' })
  })
})

interface PinCall {
  top?: number
  behavior?: ScrollBehavior
}

function logScroller(): HTMLDivElement {
  const node = container.querySelector('.overflow-y-auto')
  if (!node) throw new Error('Missing log scroller')
  return node as HTMLDivElement
}

function installScroller(initial: {
  scrollHeight: number
  clientHeight: number
}) {
  const node = logScroller()
  const metrics = { ...initial }
  const pins: Array<PinCall> = []
  Object.defineProperty(node, 'scrollHeight', {
    configurable: true,
    get: () => metrics.scrollHeight,
  })
  Object.defineProperty(node, 'clientHeight', {
    configurable: true,
    get: () => metrics.clientHeight,
  })
  node.scrollTo = ((options?: ScrollToOptions) => {
    pins.push({ top: options?.top, behavior: options?.behavior })
    if (options?.behavior !== 'smooth' && typeof options?.top === 'number') {
      node.scrollTop = options.top
      node.dispatchEvent(new Event('scroll', { bubbles: true }))
    }
  }) as typeof node.scrollTo
  return { node, pins, metrics }
}

async function publishLog(sequence: number, text: string) {
  await act(async () => {
    logListener?.({ sequence, text })
    await wait(LOG_UPDATE_INTERVAL_MS + 50)
  })
}

async function userScroll(node: HTMLElement, top: number) {
  await act(async () => {
    node.scrollTop = top
    node.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
}

function stubAnchorGeometry(
  node: HTMLElement,
  row: HTMLElement,
  rowTop: () => number,
) {
  node.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    top: 0,
    left: 0,
    right: 300,
    bottom: 200,
    toJSON: () => ({}),
  })
  row.getBoundingClientRect = () => {
    const top = rowTop()
    return {
      x: 0,
      y: top,
      width: 300,
      height: 20,
      top,
      left: 0,
      right: 300,
      bottom: top + 20,
      toJSON: () => ({}),
    }
  }
  document.elementFromPoint = () => row
}
