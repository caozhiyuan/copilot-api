import type { ConfigFieldId, ConfigSection } from '../lib/config-fields'
import type {
  ClientErrorCode,
  CodexClientOptions,
} from '../../shared/client-integrations'
import en from './en'
import zh from './zh'

export interface LocaleTree {
  [key: string]: string | LocaleTree
}

// Enforce exhaustive domain-keyed translation maps while deriving every other
// locale key directly from `en`.
type RequiredLocaleSections = {
  clients: {
    sandboxModes: Record<CodexClientOptions['sandboxMode'], string>
    approvalReviewers: Record<CodexClientOptions['approvalsReviewer'], string>
    webSearchModes: Record<CodexClientOptions['webSearch'], string>
    errors: Record<ClientErrorCode, string>
  }
  configEditor: {
    groups: Record<ConfigSection, string>
    fields: Record<ConfigFieldId, { label: string; description: string }>
  }
}

type DeepStringRecord<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringRecord<T[K]>
}

export type Locale = DeepStringRecord<typeof en>

export type Language = 'en' | 'zh'
export type LangPreference = Language | 'auto'
export type LocaleVars = Record<string, string | number>

// Dot-path key type with autocomplete and compile-time missing-key checks.
type DotPaths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}`
  : DotPaths<T[K], `${P}${K}.`>
}[keyof T & string]

export type LocaleKey = DotPaths<Locale>

export const locales: Record<Language, Locale & RequiredLocaleSections> = {
  en,
  zh,
}

function detectLanguage(systemLocale: string): Language {
  const normalizedLocale = systemLocale.toLowerCase()
  if (normalizedLocale.startsWith('zh')) return 'zh'
  return 'en'
}

export function resolveLanguage(
  pref: LangPreference,
  systemLocale: string,
): Language {
  if (pref === 'auto') return detectLanguage(systemLocale)
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

function interpolate(template: string, vars?: LocaleVars): string {
  if (!vars) return template

  let result = template
  for (const [key, value] of Object.entries(vars)) {
    // A function replacer keeps $&, $$, $` and $' literal in the value.
    result = result.replace(`{{${key}}}`, () => String(value))
  }
  return result
}

export function translate(
  key: LocaleKey,
  pref: LangPreference,
  vars?: LocaleVars,
  systemLocale = 'en',
): string {
  const lang = resolveLanguage(pref, systemLocale)
  return interpolate(getNestedValue(locales[lang], key), vars)
}
