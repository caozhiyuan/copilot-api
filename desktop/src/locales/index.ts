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
  settings: {
    title: string
    restartNote: string
    sectionGeneral: string
    minimizeToTray: string
    minimizeToTrayDesc: string
    sectionProxy: string
    httpProxy: string
    httpsProxy: string
    sectionStartup: string
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

// 点路径类型 — key 自动补全 + 漏译编译报错
type DotPaths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : DotPaths<T[K], `${P}${K}.`>
}[keyof T & string]

export type LocaleKey = DotPaths<Locale>

export const locales: Record<Language, Locale> = { en, zh }
