import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { translate, type LangPreference, type LocaleKey } from '../locales'

interface LanguageContextValue {
  langPref: LangPreference
  setLangPref: (pref: LangPreference) => void
  t: (key: LocaleKey, vars?: Record<string, string | number>) => string
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [langPref, setLangPref] = useState<LangPreference>('auto')

  const t = useCallback(
    (key: LocaleKey, vars?: Record<string, string | number>): string => {
      return translate(key, langPref, vars, navigator.language)
    },
    [langPref],
  )

  const value = useMemo(() => ({ langPref, setLangPref, t }), [langPref, t])

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
