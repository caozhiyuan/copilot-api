import { createContext, useContext, useState, type ReactNode } from 'react'
import { locales, type Language, type LangPreference, type LocaleKey } from '../locales'

function detectSystemLanguage(): Language {
  const lang = navigator.language.toLowerCase()
  if (lang.startsWith('zh')) return 'zh'
  return 'en'
}

export function resolveLanguage(pref: LangPreference): Language {
  if (pref === 'auto') return detectSystemLanguage()
  return pref
}

function getNestedValue(obj: unknown, path: string): string {
  const keys = path.split('.')
  let value: unknown = obj
  for (const key of keys) {
    value = (value as Record<string, unknown>)[key]
  }
  return value as string
}

interface LanguageContextValue {
  langPref: LangPreference
  setLangPref: (pref: LangPreference) => void
  t: (key: LocaleKey, vars?: Record<string, string | number>) => string
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [langPref, setLangPref] = useState<LangPreference>('auto')

  const t = (key: LocaleKey, vars?: Record<string, string | number>): string => {
    const lang = resolveLanguage(langPref)
    let str = getNestedValue(locales[lang], key)
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replace(`{{${k}}}`, String(v))
      }
    }
    return str
  }

  return (
    <LanguageContext.Provider value={{ langPref, setLangPref, t }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used within LanguageProvider')
  return ctx
}
