import en from './en'
import zh from './zh'

export interface Locale {
  auth: {
    subtitle: string
    githubAuth: string
    codexAuth: string
    customProvider: string
    loading: string
    manualToken: string
    providerApiKey: string
    providerAuthType: string
    providerAuthTypeDefault: string
    providerBaseUrl: string
    providerDashscope: string
    providerDeepseek: string
    providerInvalid: string
    providerName: string
    providerOpencodeGo: string
    providerOpenrouter: string
    providerType: string
    deviceCode: string
    deviceCodeUrl: string
    codexCallbackRequired: string
    copy: string
    copied: string
    openAuthPage: string
    waitingAuth: string
    back: string
    backToHome: string
    verifying: string
    confirmAdd: string
    authFailed: string
    tokenInvalid: string
    waitingCodexAuth: string
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
    tabTokenUsage: string
    tabLogs: string
    overviewStatus: string
    overviewRunning: string
    overviewPort: string
    overviewModels: string
    overviewLastRefresh: string
    premiumUsed: string
    quotaReset: string
    serviceAddress: string
    authHeader: string
    copy: string
    quotaUsage: string
    refreshing: string
    refresh: string
    tokenUsage: string
    tokenUsageAllModels: string
    tokenUsageCache: string
    tokenUsageCacheRead: string
    tokenUsageCacheWrite: string
    tokenUsageCost: string
    tokenUsageEndpoint: string
    tokenUsageEvents: string
    tokenUsageInput: string
    tokenUsageModel: string
    tokenUsageModelBreakdown: string
    tokenUsageOutput: string
    tokenUsagePage: string
    tokenUsagePeriodDay: string
    tokenUsagePeriodMonth: string
    tokenUsagePeriodWeek: string
    tokenUsageProvider: string
    tokenUsageRequests: string
    tokenUsageSession: string
    tokenUsageSource: string
    tokenUsageTime: string
    tokenUsageTotal: string
    tokenUsageTotalCost: string
    tokenUsageTotalTokens: string
    tokenUsageTrend: string
    tokenUsageTrace: string
    tokenUsageUser: string
    availableModels: string
    modelsCount: string
    next: string
    loading: string
    noModels: string
    noTokenUsage: string
    previous: string
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
    appSettings: string
    advancedConfig: string
    changeAuth: string
    restart: string
    restarting: string
  }
  tray: {
    showWindow: string
    quit: string
  }
  menu: {
    file: string
    fileSettings: string
    fileQuit: string
    view: string
    viewReload: string
    viewZoomIn: string
    viewZoomOut: string
    viewZoomReset: string
    help: string
    helpAbout: string
    aboutVersion: string
    helpDocs: string
  }
  server: {
    tokenNotFound: string
    authRequired: string
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
    launchAtLogin: string
    launchAtLoginDesc: string
    minimizeToTray: string
    minimizeToTrayDesc: string
    sectionNetwork: string
    proxySystemNote: string
    proxyMode: string
    proxyModeSystem: string
    proxyModeCustom: string
    proxyModeDirect: string
    httpProxy: string
    httpsProxy: string
    noProxy: string
    noProxyDesc: string
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
    sectionTheme: string
    themeLight: string
    themeDark: string
    themeAuto: string
    cancel: string
    save: string
    saving: string
  }
  advancedConfig: {
    title: string
    subtitle: string
    back: string
    modelMappingsTitle: string
    modelMappingsDesc: string
    scopeLabel: string
    scopeNote: string
    restartNote: string
    configPath: string
    addMapping: string
    sourceModel: string
    targetModel: string
    remove: string
    emptyTitle: string
    emptyDescription: string
    saveHelp: string
    saved: string
    loadFailed: string
    saveFailed: string
    serverRequired: string
    validationIncomplete: string
    validationDuplicate: string
  }
}

export type Language = 'en' | 'zh'
export type LangPreference = Language | 'auto'
export type LocaleVars = Record<string, string | number>

// Dot-path key type with autocomplete and compile-time missing-key checks.
type DotPaths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}`
  : DotPaths<T[K], `${P}${K}.`>
}[keyof T & string]

export type LocaleKey = DotPaths<Locale>

export const locales: Record<Language, Locale> = { en, zh }

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
    result = result.replace(`{{${key}}}`, String(value))
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
