import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"

import { i18n, LOCALE_STORAGE_KEY, type SupportedLocale, readLocalePreference } from "@/lib/i18n"

function writeLocalePreference(value: SupportedLocale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, value)
  } catch {
    // ignore
  }
}

export type LocalePreferenceContextValue = {
  locale: SupportedLocale
  setLocale: (value: SupportedLocale) => void
}

const LocalePreferenceContext = createContext<LocalePreferenceContextValue | null>(null)

export function LocalePreferenceProvider({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [locale, setLocaleState] = useState<SupportedLocale>(() => readLocalePreference())

  const setLocale = useCallback((value: SupportedLocale) => {
    setLocaleState(value)
  }, [])

  useEffect(() => {
    writeLocalePreference(locale)
  }, [locale])

  useEffect(() => {
    document.documentElement.lang = locale
    void i18n.changeLanguage(locale)
  }, [locale])

  const value = useMemo<LocalePreferenceContextValue>(() => {
    return { locale, setLocale }
  }, [locale, setLocale])

  return <LocalePreferenceContext.Provider value={value}>{children}</LocalePreferenceContext.Provider>
}

export function useLocalePreference(): LocalePreferenceContextValue {
  const ctx = useContext(LocalePreferenceContext)
  if (!ctx) {
    throw new Error("useLocalePreference must be used within LocalePreferenceProvider")
  }
  return ctx
}
