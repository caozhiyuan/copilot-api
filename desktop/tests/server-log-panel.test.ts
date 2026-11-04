import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

import ServerLogPanel from '../src/components/ServerLogPanel'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import type { ServerLogRecord } from '../src/types/ipc'

let win: Window
let root: Root
let container: HTMLDivElement
let logListener: ((log: ServerLogRecord) => void) | null
const previousGlobals = new Map<string, PropertyDescriptor | undefined>()

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
  test('shows history and live lines, then clears stored and displayed logs', async () => {
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
    expect(container.textContent).toContain('another history log')

    await act(async () => {
      logListener?.({ sequence: 4, text: 'live one' })
      logListener?.({ sequence: 5, text: 'live two' })
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
    expect(container.textContent).toContain('No logs yet')

    await reopenPanel('page')
    expect(container.textContent).not.toContain('history log')
    expect(container.textContent).not.toContain('another history log')
    expect(container.textContent).not.toContain('live one')
  })

  test('keeps a log emitted after the cleared sequence and drops a late stale one', async () => {
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
      logListener?.({ sequence: 1, text: 'history log' })
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

  test('keeps distinct identical lines that arrive before history loads', async () => {
    let resolveHistory: ((logs: Array<ServerLogRecord>) => void) | undefined
    window.electronAPI.getLogs = mock(
      () =>
        new Promise<Array<ServerLogRecord>>((resolve) => {
          resolveHistory = resolve
        }),
    )
    await renderPanel('failure')
    expect(container.textContent).toContain('Loading')

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
    expect(container.textContent).toContain('history log')
  })

  test('shows live lines when history loading fails', async () => {
    window.electronAPI.getLogs = mock(() =>
      Promise.reject(new Error('history unavailable')),
    )
    await renderPanel('page')

    await act(async () => {
      logListener?.({ sequence: 1, text: 'live after subscribe' })
    })

    expect(container.textContent).toContain('live after subscribe')
  })

  test.each(['page', 'failure'] as const)(
    'shows the latest history and growing live output immediately in the %s panel',
    async (variant) => {
      const history = Promise.withResolvers<Array<ServerLogRecord>>()
      window.electronAPI.getLogs = mock(() => history.promise)
      await renderPanel(variant)
      const view = installScroller({ scrollHeight: 10_000, clientHeight: 200 })

      await act(async () => {
        history.resolve([{ sequence: 1, text: 'history' }])
      })
      expect(view.node.scrollTop).toBe(9800)

      for (let sequence = 2; sequence <= 21; sequence += 1) {
        view.metrics.scrollHeight += 40
        await publishLog(sequence, `live ${sequence}`)
        expect(view.node.scrollTop).toBe(view.metrics.scrollHeight - 200)
      }
      expect(view.pins.every((pin) => pin.behavior === 'instant')).toBe(true)
    },
  )

  test('lets the reader scroll up and resumes inside the follow band', async () => {
    await renderPanel('page')
    const view = installScroller({ scrollHeight: 1000, clientHeight: 200 })
    await publishLog(1, 'pinned')

    await userScroll(view.node, 600)
    view.metrics.scrollHeight = 1300
    await publishLog(2, 'while reading')
    expect(view.node.scrollTop).toBe(600)

    await userScroll(view.node, 1050)
    expect(view.node.scrollTop).toBe(1100)
    expect(view.pins.at(-1)?.behavior).toBe('instant')
  })

  test('keeps following when the viewport is clamped onto the bottom', async () => {
    await renderPanel('page')
    const view = installScroller({ scrollHeight: 1000, clientHeight: 200 })
    await publishLog(1, 'pinned')

    view.metrics.scrollHeight = 900
    await userScroll(view.node, 700)
    view.metrics.scrollHeight = 1100
    await publishLog(2, 'still pinned')

    expect(view.node.scrollTop).toBe(900)
  })

  test('keeps surviving rows available for native anchoring when old logs are evicted', async () => {
    window.electronAPI.getLogs = mock(() =>
      Promise.resolve(
        Array.from({ length: 2000 }, (_, index) => ({
          sequence: index + 1,
          text: `line ${index + 1}`,
        })),
      ),
    )
    await renderPanel('page')
    const view = installScroller({ scrollHeight: 40_000, clientHeight: 200 })
    await userScroll(view.node, 15_000)
    const row = [...view.node.children].find(
      (node) => node.textContent === 'line 649',
    ) as HTMLElement
    const pinsBefore = view.pins.length

    await act(async () => {
      for (let sequence = 2001; sequence <= 2020; sequence += 1) {
        logListener?.({ sequence, text: `line ${sequence}` })
      }
    })

    expect(view.node.children).toHaveLength(2000)
    expect(view.node.firstElementChild?.textContent).toBe('line 21')
    expect(
      [...view.node.children].find((node) => node.textContent === 'line 649'),
    ).toBe(row)
    expect(view.node.style.overflowAnchor).not.toBe('none')
    expect(row.style.overflowAnchor).not.toBe('none')
    expect(view.pins).toHaveLength(pinsBefore)
  })

  test('pins again after clear once the reader had scrolled away', async () => {
    await renderPanel('page')
    const view = installScroller({ scrollHeight: 1000, clientHeight: 200 })
    await publishLog(1, 'pinned')
    await userScroll(view.node, 100)
    window.electronAPI.clearLogs = mock(() => {
      view.metrics.scrollHeight = 200
      return Promise.resolve(1)
    })

    await act(async () => {
      findClearButton().click()
      await Promise.resolve()
    })

    expect(view.node.scrollTop).toBe(0)
    expect(container.textContent).toContain('No logs yet')
    view.metrics.scrollHeight = 500
    await publishLog(2, 'after clear')
    expect(view.node.scrollTop).toBe(300)
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
      node.scrollTop = Math.max(
        0,
        Math.min(options.top, metrics.scrollHeight - metrics.clientHeight),
      )
      node.dispatchEvent(new Event('scroll', { bubbles: true }))
    }
  }) as typeof node.scrollTo
  return { node, pins, metrics }
}

async function publishLog(sequence: number, text: string) {
  await act(async () => {
    logListener?.({ sequence, text })
  })
}

async function userScroll(node: HTMLElement, top: number) {
  await act(async () => {
    node.scrollTop = top
    node.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
}
