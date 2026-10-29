import type { ConfigFieldId, ConfigSection } from '../lib/config-fields'
import en from './en'
import zh from './zh'

export interface Locale {
  studio: {
    title: string
    description: string
    generate: string
    edit: string
    video: string
    provider: string
    gateway: string
    model: string
    prompt: string
    imagePrompt: string
    editPrompt: string
    videoPrompt: string
    size: string
    quality: string
    count: string
    auto: string
    low: string
    medium: string
    high: string
    upload: string
    uploadHint: string
    uploadError: string
    remove: string
    firstFrame: string
    firstFrameHint: string
    duration: string
    ratio: string
    resolution: string
    audio: string
    create: string
    creating: string
    cancel: string
    cancelled: string
    results: string
    empty: string
    save: string
    saving: string
    saved: string
    viewOriginal: string
    closePreview: string
    useAsInput: string
    failed: string
    videoFailed: string
    pending: string
    paused: string
    pause: string
    discard: string
    resume: string
    requestId: string
    stopped: string
    gatewayHint: string
    videoHint: string
  }
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
    packageReady: string
    showPackage: string
    openPackage: string
    manualPackageNote: string
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
    backToProviders: string
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
    usageSnapshot: string
    usageSnapshotTopModel: string
    usageSnapshotModelRequests: string
    serviceAddress: string
    authHeader: string
    copy: string
    quotaUsage: string
    subscriptionQuota: string
    tabSubscriptions: string
    quotaRefreshAll: string
    quotaRemaining: string
    quotaRequests: string
    quotaAvailableBalance: string
    quotaLoadFailedShort: string
    quotaLimitReachedShort: string
    quotaConnected: string
    quotaNotConnected: string
    quotaRefreshProvider: string
    quotaLiveUsage: string
    quotaAccountUsage: string
    quotaPageDescription: string
    quotaProviderCount: string
    quotaEmptyTitle: string
    quotaEmptyDescription: string
    quotaMonthlyCredits: string
    quotaOnDemand: string
    quotaWeekly: string
    quotaMonthly: string
    quotaDays: string
    quotaHours: string
    quotaMinutes: string
    quotaAllowance: string
    quotaCredits: string
    quotaPrepaid: string
    quotaCreditsAvailable: string
    quotaUnlimited: string
    quotaLimitReached: string
    quotaWorkspaceCreditsDepleted: string
    quotaWorkspaceLimitReached: string
    quotaLoadFailed: string
    quotaAccountUnavailable: string
    quotaResetsOn: string
    quotaUnavailable: string
    quotaUsedPercent: string
    quotaRemainingPercent: string
    providerOverview: string
    providerOverviewSummary: string
    providerOverviewManage: string
    providerOverviewModels: string
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
    tokenUsageAverageFirstToken: string
    tokenUsageOutputSpeed: string
    tokenUsageDuration: string
    tokenUsageTimingHint: string
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
    showCreate: string
    showCreateDesc: string
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
  configEditor: {
    title: string
    editMode: string
    form: string
    json: string
    groupsLabel: string
    resetGroup: string
    useDefault: string
    inherited: string
    explicit: string
    defaultValue: string
    explicitValue: string
    reload: string
    reloadDiscard: string
    mergeLatest: string
    mergeConflicts: string
    keepMine: string
    keepDisk: string
    merged: string
    legacyWarning: string
    errors: {
      conflict: string
      validation: string
      readFailed: string
      saveFailed: string
      applyFailed: string
    }
    discard: string
    review: string
    close: string
    saveApply: string
    save: string
    synced: string
    unsaved: string
    unsavedOther: string
    offline: string
    invalid: string
    savedApplied: string
    savedOffline: string
    savedNotApplied: string
    retryApply: string
    showSecrets: string
    format: string
    jsonContent: string
    sharedDraft: string
    maskedReadOnly: string
    maskedUnavailable: string
    mappingDefaults: string
    autoModelDefault: string
    autoModelOff: string
    autoModelCustom: string
    groups: Record<ConfigSection, string>
    fields: Record<ConfigFieldId, { label: string; description: string }>
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
