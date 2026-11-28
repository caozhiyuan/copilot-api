import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
  type ReactNode,
} from 'react'
import type { ThemePreference } from '../types/ipc'

type ResolvedTheme = 'light' | 'dark'

interface ThemeContextValue {
  themePref: ThemePreference
  resolvedTheme: ResolvedTheme
  setThemePref: (pref: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ?
      'dark'
    : 'light'
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === 'auto' ? getSystemTheme() : pref
}

function applyThemeClass(theme: ResolvedTheme): void {
  const root = document.documentElement
  if (theme === 'dark') {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themePref, setThemePrefState] = useState<ThemePreference>('auto')
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme('auto'),
  )

  useEffect(() => {
    let active = true
    window.electronAPI
      .getSettings()
      .then((settings) => {
        if (!active) return
        setThemePrefState(settings.theme)
        const resolved = resolveTheme(settings.theme)
        setResolvedTheme(resolved)
        applyThemeClass(resolved)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (themePref !== 'auto') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      const resolved = getSystemTheme()
      setResolvedTheme(resolved)
      applyThemeClass(resolved)
    }
    media.addEventListener('change', handler)
    return () => media.removeEventListener('change', handler)
  }, [themePref])

  const setThemePref = useCallback((pref: ThemePreference) => {
    setThemePrefState(pref)
    const resolved = resolveTheme(pref)
    setResolvedTheme(resolved)
    applyThemeClass(resolved)
  }, [])

  const value = useMemo(
    () => ({ themePref, resolvedTheme, setThemePref }),
    [themePref, resolvedTheme, setThemePref],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
