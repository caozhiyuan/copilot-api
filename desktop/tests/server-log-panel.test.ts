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
      await wait(70)
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
      await wait(70)
    })

    expect(container.textContent).toContain('live after subscribe')
  })
})
