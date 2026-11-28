import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, createElement, useEffect, type ErrorInfo } from 'react'
import {
  AppErrorBoundary,
  ErrorBoundary,
} from '../src/components/ErrorBoundary'
import { LanguageProvider, useLanguage } from '../src/contexts/LanguageContext'
import { ThemeProvider, useTheme } from '../src/contexts/ThemeContext'
import type { LangPreference } from '../src/locales'
import { createTestDom } from './helpers/dom'

let dom: Awaited<ReturnType<typeof createTestDom>>

beforeEach(async () => {
  dom = await createTestDom()
})

afterEach(async () => {
  await act(async () => dom.root.unmount())
  await dom.cleanup()
})

function clickButton(text: string) {
  const button = [...dom.container.querySelectorAll('button')].find(
    (item) => item.textContent === text,
  )
  if (!button) throw new Error(`Missing button: ${text}`)
  return act(async () => button.click())
}

function suppressConsoleError<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error
  const spy = mock(() => {})
  console.error = spy
  return fn().finally(() => {
    console.error = original
  })
}

describe('ErrorBoundary', () => {
  test('renders children when no error occurs and recovers on retry', async () => {
    let shouldThrow = true
    const onError = mock((_error: Error, _info: ErrorInfo) => {})
    const onReset = mock(() => {})

    function UnstableView() {
      if (shouldThrow) throw new Error('boom from child')
      return createElement('div', null, 'healthy content')
    }

    await suppressConsoleError(async () => {
      await act(async () => {
        dom.root.render(
          createElement(ErrorBoundary, {
            onError,
            onReset,
            children: createElement(UnstableView),
          }),
        )
      })
    })

    expect(
      dom.container.querySelector('[role="alert"]')?.textContent,
    ).toContain('Something went wrong')
    expect(dom.container.textContent).toContain('boom from child')
    expect(onError).toHaveBeenCalledTimes(1)

    shouldThrow = false
    await clickButton('Try again')

    expect(onReset).toHaveBeenCalledTimes(1)
    expect(dom.container.querySelector('[role="alert"]')).toBeNull()
    expect(dom.container.textContent).toContain('healthy content')
  })

  test('logs to console.error by default and supports custom, electron, and location reload', async () => {
    const originalConsoleError = console.error
    const consoleSpy = mock(() => {})
    console.error = consoleSpy

    function BrokenView(): never {
      throw new Error('render crash')
    }

    try {
      const onReload = mock(() => {})
      await act(async () => {
        dom.root.render(
          createElement(ErrorBoundary, {
            onReload,
            children: createElement(BrokenView),
          }),
        )
      })
      expect(consoleSpy).toHaveBeenCalled()
      await clickButton('Reload window')
      expect(onReload).toHaveBeenCalledTimes(1)

      const windowReload = mock(() => {})
      Object.defineProperty(dom.win, 'electronAPI', {
        configurable: true,
        value: { windowReload },
      })
      await act(async () => {
        dom.root.render(
          createElement(ErrorBoundary, {
            children: createElement(BrokenView),
          }),
        )
      })
      await clickButton('Reload window')
      expect(windowReload).toHaveBeenCalledTimes(1)

      Object.defineProperty(dom.win, 'electronAPI', {
        configurable: true,
        value: undefined,
      })
      const locationReload = mock(() => {})
      Object.defineProperty(dom.win.location, 'reload', {
        configurable: true,
        value: locationReload,
      })
      await clickButton('Reload window')
      expect(locationReload).toHaveBeenCalledTimes(1)
    } finally {
      console.error = originalConsoleError
    }
  })

  test('AppErrorBoundary renders localized copy from LanguageProvider', async () => {
    let shouldThrow = false

    function CrashSwitch({ language }: { language: LangPreference }) {
      const { setLangPref } = useLanguage()
      useEffect(() => setLangPref(language), [language, setLangPref])
      if (shouldThrow) throw new Error('localized boom')
      return createElement('span', null, 'ok')
    }

    await act(async () => {
      dom.root.render(
        createElement(LanguageProvider, {
          children: createElement(AppErrorBoundary, {
            onError: () => {},
            children: createElement(CrashSwitch, { language: 'zh' }),
          }),
        }),
      )
    })

    shouldThrow = true
    await suppressConsoleError(async () => {
      await act(async () => {
        dom.root.render(
          createElement(LanguageProvider, {
            children: createElement(AppErrorBoundary, {
              onError: () => {},
              children: createElement(CrashSwitch, { language: 'zh' }),
            }),
          }),
        )
      })
    })

    expect(dom.container.textContent).toContain('页面渲染出错了')
    expect(dom.container.textContent).toContain('重新加载窗口')
    expect(dom.container.textContent).toContain('localized boom')
  })
})

describe('LanguageContext and ThemeContext stability', () => {
  test('LanguageProvider keeps context value and t stable across parent rerenders', async () => {
    const snapshots: Array<ReturnType<typeof useLanguage>> = []

    function Probe() {
      const ctx = useLanguage()
      snapshots.push(ctx)
      return createElement('span', null, ctx.t('errorBoundary.retry'))
    }

    function Host({ tick }: { tick: number }) {
      return createElement(LanguageProvider, {
        children: createElement(
          'div',
          { 'data-tick': tick },
          createElement(Probe),
        ),
      })
    }

    await act(async () => {
      dom.root.render(createElement(Host, { tick: 1 }))
    })
    await act(async () => {
      dom.root.render(createElement(Host, { tick: 2 }))
    })

    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]).toBe(snapshots[0])
    expect(snapshots[1].t).toBe(snapshots[0].t)

    await act(async () => {
      snapshots[0].setLangPref('zh')
    })

    expect(snapshots.at(-1)).not.toBe(snapshots[0])
    expect(dom.container.textContent).toBe('重试')
  })

  test('ThemeProvider keeps context value stable and reacts to preference and system changes', async () => {
    let mediaDark = false
    let changeHandler: (() => void) | null = null
    Object.defineProperty(dom.win, 'matchMedia', {
      configurable: true,
      value: () => ({
        get matches() {
          return mediaDark
        },
        addEventListener: (_event: string, cb: () => void) => {
          changeHandler = cb
        },
        removeEventListener: (_event: string, cb: () => void) => {
          if (changeHandler === cb) changeHandler = null
        },
      }),
    })
    Object.defineProperty(dom.win, 'electronAPI', {
      configurable: true,
      value: {
        getSettings: () => Promise.resolve({ theme: 'auto' }),
      },
    })

    const snapshots: Array<ReturnType<typeof useTheme>> = []

    function Probe() {
      const ctx = useTheme()
      snapshots.push(ctx)
      return createElement(
        'span',
        null,
        `${ctx.themePref}:${ctx.resolvedTheme}`,
      )
    }

    function Host({ tick }: { tick: number }) {
      return createElement(ThemeProvider, {
        children: createElement(
          'div',
          { 'data-tick': tick },
          createElement(Probe),
        ),
      })
    }

    await act(async () => {
      dom.root.render(createElement(Host, { tick: 1 }))
    })
    const afterMount = snapshots.at(-1)!
    await act(async () => {
      dom.root.render(createElement(Host, { tick: 2 }))
    })
    expect(snapshots.at(-1)).toBe(afterMount)

    mediaDark = true
    await act(async () => {
      changeHandler?.()
    })
    expect(dom.win.document.documentElement.classList.contains('dark')).toBe(
      true,
    )
    expect(dom.container.textContent).toBe('auto:dark')

    await act(async () => {
      snapshots.at(-1)!.setThemePref('light')
    })
    expect(dom.win.document.documentElement.classList.contains('dark')).toBe(
      false,
    )
    expect(dom.container.textContent).toBe('light:light')
  })

  test('useLanguage and useTheme throw outside their providers', async () => {
    function OutsideLanguage() {
      useLanguage()
      return null
    }
    function OutsideTheme() {
      useTheme()
      return null
    }

    let languageError: Error | undefined
    let themeError: Error | undefined

    await suppressConsoleError(async () => {
      await act(async () => {
        dom.root.render(
          createElement(ErrorBoundary, {
            key: 'lang-boundary',
            onError: (err) => {
              languageError = err
            },
            children: createElement(OutsideLanguage),
          }),
        )
      })
    })
    expect(languageError?.message).toContain('LanguageProvider')

    await suppressConsoleError(async () => {
      await act(async () => {
        dom.root.render(
          createElement(ErrorBoundary, {
            key: 'theme-boundary',
            onError: (err) => {
              themeError = err
            },
            children: createElement(OutsideTheme),
          }),
        )
      })
    })
    expect(themeError?.message).toContain('ThemeProvider')
  })
})
