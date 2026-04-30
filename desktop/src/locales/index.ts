import en from './en'
import zh from './zh'

export interface Locale {
  auth: {
    subtitle: string
    githubAuth: string
    loading: string
    manualToken: string
    deviceCode: string
    copy: string
    copied: string
    openAuthPage: string
    waitingAuth: string
    back: string
    verifying: string
    confirmAdd: string
    authFailed: string
    tokenInvalid: string
    loginConsent: string
  }
  dashboard: {
    invalidPort: string
    serverStopped: string
    configPort: string
    port: string
    serverUnexpectedStop: string
    starting: string
    startServer: string
    tabDashboard: string
    tabLogs: string
    premiumUsed: string
    quotaReset: string
    serviceAddress: string
    authHeader: string
    copy: string
    quotaUsage: string
    refreshing: string
    refresh: string
    availableModels: string
    modelsCount: string
    loading: string
    noModels: string
    serverLog: string
    clear: string
    noLogs: string
  }
  header: {
    stop: string
    running: string
    notStarted: string
    logout: string
    settings: string
  }
  tray: {
    showWindow: string
    quit: string
  }
  server: {
    tokenNotFound: string
    portInUse: string
    startFailed: string
    startTimeout: string
    processExit: string
  }
  settings: {
    title: string
    restartAppNote: string
    restartAppPrompt: string
    sectionGeneral: string
    minimizeToTray: string
    minimizeToTrayDesc: string
    sectionStartup: string
    oauthApp: string
    oauthAppDefault: string
    oauthAppDesc: string
    apiHome: string
    apiHomeDesc: string
    enterpriseUrl: string
    enterpriseUrlDesc: string
    verbose: string
    verboseDesc: string
    showToken: string
    showTokenDesc: string
    sectionLanguage: string
    langAuto: string
    langEn: string
    langZh: string
    cancel: string
    save: string
    saving: string
  }
}

export type Language = 'en' | 'zh'
export type LangPreference = Language | 'auto'
export type LocaleVars = Record<string, string | number>

// Dot-path key type with autocomplete and compile-time missing-key checks.
type DotPaths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : DotPaths<T[K], `${P}${K}.`>
}[keyof T & string]

export type LocaleKey = DotPaths<Locale>

export const locales: Record<Language, Locale> = { en, zh }

function detectLanguage(systemLocale: string): Language {
  const normalizedLocale = systemLocale.toLowerCase()
  if (normalizedLocale.startsWith('zh')) return 'zh'
  return 'en'
}

export function resolveLanguage(pref: LangPreference, systemLocale: string): Language {
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
    result = result.replace(`{{${key}}}`, String(value))
  }
  return result
}

export function translate(
  key: LocaleKey,
  pref: LangPreference,
  vars?: LocaleVars,
  systemLocale = 'en'
): string {
  const lang = resolveLanguage(pref, systemLocale)
  return interpolate(getNestedValue(locales[lang], key), vars)
}
