import i18n from "i18next"
import { initReactI18next } from "react-i18next"

import enUS from "@/locales/en-US.json"
import zhCN from "@/locales/zh-CN.json"

export type SupportedLocale = "en-US" | "zh-CN"

export const DEFAULT_LOCALE: SupportedLocale = "en-US"
export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ["en-US", "zh-CN"] as const

export const LOCALE_STORAGE_KEY = "locale"

export function normalizeLocale(raw: string | null | undefined): SupportedLocale {
  if (!raw) return DEFAULT_LOCALE

  const normalized = raw.toLowerCase().trim().replace(/_/g, "-")

  if (normalized.startsWith("zh")) return "zh-CN"
  if (normalized.startsWith("en")) return "en-US"

  return DEFAULT_LOCALE
}

export function readLocalePreference(): SupportedLocale {
  if (typeof window === "undefined") return DEFAULT_LOCALE
  try {
    const stored = globalThis.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored) return normalizeLocale(stored)

    const fromNavigator =
      (Array.isArray(navigator.languages) && navigator.languages[0]) || navigator.language

    return normalizeLocale(fromNavigator)
  } catch {
    return DEFAULT_LOCALE
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    "en-US": { translation: enUS },
    "zh-CN": { translation: zhCN },
  },
  lng: readLocalePreference(),
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: [...SUPPORTED_LOCALES],
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
  initImmediate: false,
})

export { i18n }
