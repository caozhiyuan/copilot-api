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
const THEME_STORAGE_KEY = 'copilot-api-theme-pref'

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'auto'
}

function readCachedThemePref(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(saved) ? saved : 'auto'
  } catch {
    return 'auto'
  }
}

function writeCachedThemePref(pref: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, pref)
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

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
  const [themePref, setThemePrefState] =
    useState<ThemePreference>(readCachedThemePref)
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => {
    const initial = resolveTheme(readCachedThemePref())
    if (typeof document !== 'undefined') applyThemeClass(initial)
    return initial
  })

  useEffect(() => {
    let active = true
    window.electronAPI
      .getSettings()
      .then((settings) => {
        if (!active) return
        setThemePrefState(settings.theme)
        writeCachedThemePref(settings.theme)
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
    writeCachedThemePref(pref)
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
