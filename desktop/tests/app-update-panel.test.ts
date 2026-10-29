import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

import AppUpdatePanel from '../src/components/AppUpdatePanel'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import type { AppUpdateStatus } from '../src/types/ipc'

const initial: AppUpdateStatus = {
  phase: 'idle',
  currentVersion: '2.6.29',
  manualInstall: false,
  releaseUrl: 'https://github.com/caozhiyuan/copilot-api/releases',
}
let win: Window
let root: Root
let container: HTMLDivElement
let listener: (status: AppUpdateStatus) => void
let getStatus: ReturnType<
  typeof mock<typeof window.electronAPI.getAppUpdateStatus>
>
let check: ReturnType<typeof mock<typeof window.electronAPI.checkAppUpdate>>
let install: ReturnType<typeof mock<typeof window.electronAPI.installAppUpdate>>
let openUrl: ReturnType<typeof mock<typeof window.electronAPI.openUrl>>
let openPackage: ReturnType<
  typeof mock<typeof window.electronAPI.openAppUpdatePackage>
>
let unsubscribe: ReturnType<typeof mock<() => void>>
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
  getStatus = mock(() => Promise.resolve({ ...initial }))
  check = mock(() => Promise.resolve({ ...initial }))
  install = mock(() => Promise.resolve({ ...initial }))
  openUrl = mock(() => Promise.resolve())
  openPackage = mock(() => Promise.resolve())
  unsubscribe = mock(() => {})
  Object.defineProperty(win, 'electronAPI', {
    value: {
      getAppUpdateStatus: getStatus,
      checkAppUpdate: check,
      installAppUpdate: install,
      openUrl,
      openAppUpdatePackage: openPackage,
      onAppUpdateStatus: (callback: typeof listener) => {
        listener = callback
        return unsubscribe
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
  expect(unsubscribe).toHaveBeenCalledTimes(1)
  await win.happyDOM.close()
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  previousGlobals.clear()
})

async function render(compact = false, checkOnMount = false) {
  await act(async () => {
    root.render(
      createElement(LanguageProvider, {
        children: createElement(AppUpdatePanel, { compact, checkOnMount }),
      }),
    )
  })
}

async function emit(changes: Partial<AppUpdateStatus>) {
  await act(async () => listener({ ...initial, ...changes }))
}

async function click() {
  const button = container.querySelector('button')
  if (!button) throw new Error('Missing update action')
  await act(async () => button.click())
}

describe('desktop update UI', () => {
  test('opens or reveals a manually installable DMG without quitting the app', async () => {
    await render()
    await emit({
      phase: 'downloaded',
      version: '2.7.44',
      packageReady: true,
      manualInstall: true,
    })
    expect(container.textContent).toContain('saved to Downloads')
    expect(container.textContent).toContain('Quit this app')
    const buttons = container.querySelectorAll('button')
    expect([...buttons].map((button) => button.textContent)).toEqual([
      'Show in folder',
      'Open installer',
    ])
    await act(async () => buttons[0].click())
    expect(openPackage).toHaveBeenCalledWith(true)
    await act(async () => buttons[1].click())
    expect(openPackage).toHaveBeenCalledWith()
    expect(install).not.toHaveBeenCalled()
  })

  test('keeps a manual package fallback beside the automatic installation action', async () => {
    await render(true)
    await emit({ phase: 'downloaded', version: '2.7.44', packageReady: true })
    expect(
      [...container.querySelectorAll('button')].map(
        (button) => button.textContent,
      ),
    ).toEqual(['Restart and install', 'Show in folder'])
    await click()
    expect(install).toHaveBeenCalledTimes(1)
    expect(openPackage).not.toHaveBeenCalled()
  })
  test('keeps a newly downloaded update when the menu check returns an older snapshot', async () => {
    let finishCheck: ((status: AppUpdateStatus) => void) | undefined
    check.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCheck = resolve
        }),
    )
    await render(false, true)
    expect(check).toHaveBeenCalledTimes(1)
    await emit({ phase: 'downloaded', version: '2.6.32' })
    await act(async () => {
      finishCheck?.({
        ...initial,
        phase: 'downloading',
        version: '2.6.32',
        percent: 10,
      })
    })
    expect(container.textContent).toContain(
      'Version 2.6.32 is ready to install',
    )
    expect(container.querySelector('button')?.textContent).toBe(
      'Restart and install',
    )
  })

  test('shows the installed version and offers a manual check', async () => {
    await render()
    expect(container.textContent).toContain('Current version: 2.6.29')
    await click()
    expect(check).toHaveBeenCalledTimes(1)
  })

  test('disables checks during downloads and displays real progress', async () => {
    await render()
    await emit({ phase: 'downloading', version: '2.6.30', percent: 42.5 })
    expect(container.textContent).toContain('Downloading 2.6.30 — 43%')
    expect(container.querySelector('button')?.disabled).toBe(true)
    expect(container.querySelector('progress')?.value).toBe(42.5)
  })

  test('requires an explicit action to install a downloaded update', async () => {
    await render()
    await emit({ phase: 'downloaded', version: '2.6.30' })
    expect(install).not.toHaveBeenCalled()
    expect(container.textContent).toContain('interrupts active requests')
    await click()
    expect(install).toHaveBeenCalledTimes(1)
  })

  test('opens the release page for manual macOS or legacy installation', async () => {
    await render(true)
    const releaseUrl = `${initial.releaseUrl}/tag/v2.6.30`
    await emit({
      phase: 'available',
      version: '2.6.30',
      manualInstall: true,
      releaseUrl,
    })
    expect(container.textContent).toContain('Download installer')
    await click()
    expect(openUrl).toHaveBeenCalledWith(releaseUrl)
    expect(install).not.toHaveBeenCalled()
  })

  test('keeps the compact banner hidden unless an update is in progress', async () => {
    await render(true)
    expect(container.childElementCount).toBe(0)
    await emit({ phase: 'error', error: 'offline' })
    expect(container.childElementCount).toBe(0)
    await emit({ phase: 'downloading', version: '2.6.30' })
    expect(container.querySelector('progress')?.value).toBe(0)
    expect(container.querySelector('button')).toBeNull()
  })

  test('disables updates in development and while installing', async () => {
    await render()
    await emit({ phase: 'disabled' })
    expect(container.querySelector('button')?.disabled).toBe(true)
    await emit({ phase: 'installing' })
    expect(container.querySelector('button')?.disabled).toBe(true)
  })

  test('shows network errors with a retry action', async () => {
    await render()
    await emit({
      phase: 'error',
      error: 'GitHub release check failed (HTTP 403)',
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'HTTP 403',
    )
    await click()
    expect(check).toHaveBeenCalledTimes(1)
  })

  test('reports rejected IPC actions', async () => {
    check.mockRejectedValueOnce(new Error('IPC disconnected'))
    await render()
    await click()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not complete',
    )
  })

  test('reports initial status errors', async () => {
    getStatus.mockRejectedValueOnce(new Error('IPC disconnected'))
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not complete',
    )
  })

  test('does not replace a fresh progress event with an older status snapshot', async () => {
    const snapshot = Promise.withResolvers<AppUpdateStatus>()
    getStatus.mockImplementation(() => snapshot.promise)
    await render()
    await emit({ phase: 'downloaded', version: '2.6.30' })
    await act(async () => snapshot.resolve(initial))
    expect(container.textContent).toContain(
      'Version 2.6.30 is ready to install',
    )
  })
})
