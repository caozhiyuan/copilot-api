import en from './en'
import zh from './zh'

export interface Locale {
  updates: {
    title: string
    description: string
    currentVersion: string
    idle: string
    checking: string
    'not-available': string
    available: string
    downloading: string
    downloaded: string
    installing: string
    error: string
    disabled: string
    check: string
    restartInstall: string
    openRelease: string
    manualInstall: string
    restartNote: string
    progress: string
    actionFailed: string
  }
  providers: {
    title: string
    close: string
    description: string
    configured: string
    unsaved: string
    autoDescription: string
    selectedDescription: string
    noneDescription: string
    hiddenTitle: string
    hiddenDescription: string
    availableCount: string
    loading: string
    empty: string
    enabled: string
    disabled: string
    selection: string
    auto: string
    selected: string
    none: string
    modelIds: string
    searchModels: string
    selectedCount: string
    selectVisible: string
    clearSelection: string
    loadingModels: string
    noModels: string
    manualModels: string
    modelSourceHint: string
    modelsError: string
    saved: string
    savedRefreshed: string
    save: string
    saving: string
  }
  auth: {
    subtitle: string
    githubAuth: string
    codexAuth: string
    xaiAuth: string
    xaiAccounts: string
    xaiNoAccounts: string
    waitingXaiAuth: string
    xaiLoginInProgress: string
    xaiAuthExpired: string
    xaiAuthDenied: string
    codexAccounts: string
    codexAccountAlias: string
    codexAccountAliasPlaceholder: string
    codexAccountLimit: string
    codexAccountRemoved: string
    codexActiveAccount: string
    codexAddAccount: string
    codexNoAccounts: string
    codexRemoveAccount: string
    codexAccountRemovedRefreshed: string
    codexAccountRefreshed: string
    codexUseAccount: string
    customProvider: string
    modelsDevProvider: string
    modelsDevManual: string
    modelsDevLoading: string
    modelsDevUnavailable: string
    loading: string
    manualToken: string
    providerApiKey: string
    providerAuthType: string
    providerAuthTypeDefault: string
    providerBaseUrl: string
    providerDashscope: string
    providerDeepseek: string
    providerInvalid: string
    providerKimi: string
    providerName: string
    providerOpencodeGo: string
    providerOpenrouter: string
    providerType: string
    deviceCode: string
    deviceCodeUrl: string
    codexAuthTimeout: string
    codexCallbackUnavailable: string
    codexLoginInProgress: string
    codexFinishingAuth: string
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
    cancelCodexAuth: string
    cancelling: string
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
    quotaUsedPercent: string
    quotaRemainingPercent: string
    refreshing: string
    refresh: string
    tokenUsage: string
    tokenUsageAllModels: string
    tokenUsageCache: string
    tokenUsageCacheRead: string
    tokenUsageCacheWrite: string
    tokenUsageCacheHitRate: string
    tokenUsageCost: string
    tokenUsageEndpoint: string
    tokenUsageEvents: string
    tokenUsageInput: string
    tokenUsageModel: string
    tokenUsageModelBreakdown: string
    tokenUsageOutput: string
    tokenUsagePage: string
    tokenUsagePeriodToday: string
    tokenUsagePeriodThisWeek: string
    tokenUsagePeriodLast7Days: string
    tokenUsagePeriodThisMonth: string
    tokenUsagePeriodLast30Days: string
    tokenUsagePeriodLifetime: string
    tokenUsageProvider: string
    tokenUsageRequests: string
    tokenUsageSession: string
    tokenUsageSessionBreakdown: string
    tokenUsageSessionsCount: string
    tokenUsageSessionsLoadFailed: string
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
    fileAuthConfig: string
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
    bunFallback: string
    runtime: string
    spawnFailed: string
    tokenNotFound: string
    authRequired: string
    portInUse: string
    startFailed: string
    startTimeout: string
    processExit: string
    invalidHost: string
    restartFailed: string
  }
  settings: {
    title: string
    restartAppNote: string
    restartAppPrompt: string
    sectionGeneral: string
    launchAtLogin: string
    launchAtLoginDesc: string
    autoStartServer: string
    autoStartServerDesc: string
    minimizeToTray: string
    minimizeToTrayDesc: string
    sectionSecurity: string
    serverKeysNote: string
    serverKeysSaveFailed: string
    desktopSettingsSaveFailed: string
    apiKeysLabel: string
    apiKeysDesc: string
    adminKeyLabel: string
    adminKeyPlaceholder: string
    adminKeyDesc: string
    sectionNetwork: string
    host: string
    hostDesc: string
    hostInvalid: string
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
    serverRuntime: string
    serverRuntimeDesc: string
    runtimeBun: string
    runtimeNode: string
    bunDetecting: string
    bunAvailable: string
    bunUnsupported: string
    bunUnavailable: string
    bunProxyNote: string
    oauthApp: string
    oauthAppDefault: string
    oauthAppDesc: string
    apiHome: string
    apiHomeDesc: string
    sqliteDbPath: string
    sqliteDbPathDesc: string
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
