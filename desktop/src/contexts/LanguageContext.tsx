import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  resolveLanguage,
  translate,
  type LangPreference,
  type LocaleKey,
} from '../locales'

const LANG_STORAGE_KEY = 'copilot-api-lang-pref'

function isLangPreference(value: string | null): value is LangPreference {
  return value === 'auto' || value === 'en' || value === 'zh'
}

export function hasCachedLangPref(): boolean {
  try {
    return isLangPreference(window.localStorage.getItem(LANG_STORAGE_KEY))
  } catch {
    return false
  }
}

function readCachedLangPref(): LangPreference {
  try {
    const saved = window.localStorage.getItem(LANG_STORAGE_KEY)
    return isLangPreference(saved) ? saved : 'auto'
  } catch {
    return 'auto'
  }
}

function writeCachedLangPref(pref: LangPreference): void {
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, pref)
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

interface LanguageContextValue {
  langPref: LangPreference
  setLangPref: (pref: LangPreference) => void
  t: (key: LocaleKey, vars?: Record<string, string | number>) => string
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [langPref, setLangPrefState] =
    useState<LangPreference>(readCachedLangPref)

  const setLangPref = useCallback((pref: LangPreference) => {
    setLangPrefState(pref)
    writeCachedLangPref(pref)
  }, [])

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = resolveLanguage(
        langPref,
        navigator.language,
      )
    }
  }, [langPref])

  const t = useCallback(
    (key: LocaleKey, vars?: Record<string, string | number>): string => {
      return translate(key, langPref, vars, navigator.language)
    },
    [langPref],
  )

  const value = useMemo(
    () => ({ langPref, setLangPref, t }),
    [langPref, setLangPref, t],
  )

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used within LanguageProvider')
  return ctx
}
