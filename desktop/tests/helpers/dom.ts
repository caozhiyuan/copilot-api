import { Window } from 'happy-dom'

export async function createTestDom() {
  const win = new Window({ url: 'http://localhost' })
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  const globals: Record<string, unknown> = {
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
  }
  for (const [name, value] of Object.entries(globals)) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    })
  }

  const container = document.createElement('div')
  document.body.append(container)
  // React DOM must detect event support after the window is installed.
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(container)

  return {
    win,
    root,
    container,
    cleanup: async () => {
      await win.happyDOM.close()
      for (const [name, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
}
