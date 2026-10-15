import { useEffect, useRef, useState } from 'react'
import type {
  AuthResult,
  CodexAccountSummary,
  DeviceCodeInfo,
  ModelsDevProviderOption,
  ProviderAuthInput,
  ProviderAuthTypeInput,
  ProviderType,
  QuickProviderName,
  XaiAuthInfo,
} from '../types/ipc'
import { useLanguage } from '../contexts/LanguageContext'
import Header from '../components/Header'
import { refreshProviderAuthStatus } from '../lib/provider-management-auth'

interface AuthPageProps {
  onBack?: () => void
  onSuccess: (result: AuthResult) => void
}

type AuthView =
  | 'default'
  | 'oauth-pending'
  | 'token-input'
  | 'provider-input'
  | 'oauth-accounts'
  | 'codex-pending'
  | 'xai-pending'
type ProviderChoice = QuickProviderName | 'custom'
type OAuthProvider = 'codex' | 'xai'

const cancelOAuthLogin = (provider: OAuthProvider) =>
  provider === 'codex' ?
    window.electronAPI.cancelCodexLogin()
  : window.electronAPI.cancelXaiLogin()

const PROVIDER_TYPES: ProviderType[] = [
  'anthropic',
  'openai-compatible',
  'openai-responses',
  'google',
]
const PROVIDER_AUTH_TYPES: ProviderAuthTypeInput[] = [
  '__default__',
  'x-api-key',
  'x-goog-api-key',
  'authorization',
]
const MAX_OAUTH_ACCOUNTS = 3
const PROVIDER_COLORS: Record<QuickProviderName, string> = {
  'opencode-go': 'bg-sky-500',
  kimi: 'bg-cyan-500',
  deepseek: 'bg-emerald-500',
  dashscope: 'bg-orange-500',
  openrouter: 'bg-violet-500',
}
// Renderer cannot import main-process config. Keep this in sync with src/lib/quick-providers.ts.
const QUICK_PROVIDER_DEFAULTS: Record<
  QuickProviderName,
  { baseUrl: string; editableType: boolean; type: ProviderType }
> = {
  'opencode-go': {
    baseUrl: 'https://opencode.ai/zen/go',
    editableType: false,
    type: 'openai-compatible',
  },
  kimi: {
    baseUrl: 'https://api.kimi.com/coding',
    editableType: true,
    type: 'openai-compatible',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/anthropic',
    editableType: true,
    type: 'anthropic',
  },
  dashscope: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    editableType: true,
    type: 'openai-compatible',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api',
    editableType: false,
    type: 'anthropic',
  },
}

export default function AuthPage({ onBack, onSuccess }: AuthPageProps) {
  const { t } = useLanguage()
  const [view, setView] = useState<AuthView>('default')
  const [deviceCode, setDeviceCode] = useState<DeviceCodeInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [providerChoice, setProviderChoice] =
    useState<ProviderChoice>('deepseek')
  const [providerName, setProviderName] = useState('')
  const [providerType, setProviderType] = useState<ProviderType>(
    QUICK_PROVIDER_DEFAULTS.deepseek.type,
  )
  const [providerBaseUrl, setProviderBaseUrl] = useState('')
  const [providerApiKey, setProviderApiKey] = useState('')
  const [providerAuthType, setProviderAuthType] =
    useState<ProviderAuthTypeInput>('__default__')
  const [modelsDevProviders, setModelsDevProviders] = useState<
    Array<ModelsDevProviderOption>
  >([])
  const [selectedModelsDevProviderId, setSelectedModelsDevProviderId] =
    useState('')
  const [modelsDevLoading, setModelsDevLoading] = useState(false)
  const [modelsDevError, setModelsDevError] = useState(false)
  const [oauthAccounts, setOAuthAccounts] = useState<
    Array<CodexAccountSummary>
  >([])
  const [accountProvider, setAccountProvider] = useState<OAuthProvider>('codex')
  const [oauthAlias, setOAuthAlias] = useState('')
  const [oauthNotice, setOAuthNotice] = useState('')
  const [codexAuthUrl, setCodexAuthUrl] = useState('')
  const [xaiAuthInfo, setXaiAuthInfo] = useState<XaiAuthInfo | null>(null)
  const [oauthSaving, setOAuthSaving] = useState(false)
  const [oauthCancelling, setOAuthCancelling] = useState(false)
  const oauthLoginRef = useRef<{
    provider: OAuthProvider
    unsubscribe: () => void
  } | null>(null)
  const [error, setError] = useState('')
  const [polling, setPolling] = useState(false)
  const [copied, setCopied] = useState(false)
  const mountedRef = useRef(false)
  const copyFeedbackTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(copyFeedbackTimer.current)
      const attempt = oauthLoginRef.current
      if (attempt) {
        attempt.unsubscribe()
        oauthLoginRef.current = null
        void cancelOAuthLogin(attempt.provider).catch(() => {})
      }
    }
  }, [])

  const completeAuth = (result: AuthResult, fallbackError: string) => {
    if (result.success) {
      onSuccess(result)
      return
    }

    setError(result.error ?? fallbackError)
  }

  const handleOAuth = async () => {
    setLoading(true)
    setError('')
    try {
      const code = await window.electronAPI.getDeviceCode()
      setDeviceCode(code)
      setView('oauth-pending')
      setPolling(true)

      const unsubscribe = window.electronAPI.onAuthSuccess((result) => {
        unsubscribe()
        setPolling(false)
        completeAuth(result, t('auth.authFailed'))
        if (!result.success) setView('default')
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleOpenDeviceUrl = () => {
    if (pendingDeviceCode)
      void window.electronAPI
        .openUrl(pendingDeviceCode.verification_uri)
        .catch((err: unknown) => setError((err as Error).message))
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      if (!mountedRef.current) return
      setCopied(true)
      clearTimeout(copyFeedbackTimer.current)
      copyFeedbackTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      if (mountedRef.current) setError((err as Error).message)
    }
  }

  const handleCopyCode = () => {
    if (pendingDeviceCode) void copyText(pendingDeviceCode.user_code)
  }

  const handleSaveToken = async () => {
    if (!tokenInput.trim()) return
    setLoading(true)
    setError('')
    try {
      const result = await window.electronAPI.saveToken(tokenInput.trim())
      completeAuth(result, t('auth.tokenInvalid'))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleBack = () => {
    const attempt = oauthLoginRef.current
    if (attempt) {
      attempt.unsubscribe()
      oauthLoginRef.current = null
      void cancelOAuthLogin(attempt.provider).catch(() => {})
      setLoading(false)
    }
    setXaiAuthInfo(null)
    setCodexAuthUrl('')
    setOAuthSaving(false)
    setOAuthCancelling(false)
    setView('default')
    setDeviceCode(null)
    setError('')
    setPolling(false)
    setTokenInput('')
    setProviderApiKey('')
    setProviderAuthType('__default__')
    setOAuthAlias('')
    setOAuthNotice('')
  }

  const handleProviderSelect = (provider: ProviderChoice) => {
    setProviderChoice(provider)
    setProviderApiKey('')
    setProviderAuthType('__default__')
    setSelectedModelsDevProviderId('')
    setModelsDevError(false)
    setError('')

    if (provider === 'custom') {
      setProviderName('')
      setProviderType('openai-compatible')
      setProviderBaseUrl('')
      if (modelsDevProviders.length === 0) {
        setModelsDevLoading(true)
        void window.electronAPI
          .getModelsDevProviders()
          .then(setModelsDevProviders)
          .catch(() => setModelsDevError(true))
          .finally(() => setModelsDevLoading(false))
      }
    } else {
      const defaults = QUICK_PROVIDER_DEFAULTS[provider]
      setProviderName(provider)
      setProviderType(defaults.type)
      setProviderBaseUrl(defaults.baseUrl)
    }

    setView('provider-input')
  }

  const handleModelsDevProviderSelect = (providerId: string) => {
    setSelectedModelsDevProviderId(providerId)
    if (!providerId) {
      setProviderName('')
      setProviderType('openai-compatible')
      setProviderBaseUrl('')
      return
    }
    const provider = modelsDevProviders.find((item) => item.id === providerId)
    if (!provider) return
    setProviderName(provider.id)
    setProviderType(provider.type)
    setProviderBaseUrl(provider.api)
    setProviderAuthType('__default__')
  }

  const handleSaveProvider = async () => {
    setLoading(true)
    setError('')

    try {
      const input: ProviderAuthInput =
        providerChoice === 'custom' ?
          {
            provider: 'custom',
            name: providerName.trim(),
            type: providerType,
            baseUrl: providerBaseUrl.trim(),
            apiKey: providerApiKey.trim(),
            authType: providerAuthType,
            modelsDevProviderId: selectedModelsDevProviderId || undefined,
          }
        : {
            provider: providerChoice,
            type: providerType,
            baseUrl: providerBaseUrl.trim(),
            apiKey: providerApiKey.trim(),
          }
      const result = await window.electronAPI.configureProvider(input)
      completeAuth(result, t('auth.providerInvalid'))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const loadOAuthAccounts = async (provider = accountProvider) => {
    const accounts = await (provider === 'codex' ?
      window.electronAPI.getCodexAccounts()
    : window.electronAPI.getXaiAccounts())
    setOAuthAccounts(accounts)
    return accounts
  }

  const handleOpenOAuthAccounts = async (provider: OAuthProvider) => {
    setAccountProvider(provider)
    setLoading(true)
    setError('')
    setOAuthNotice('')
    try {
      await loadOAuthAccounts(provider)
      setView('oauth-accounts')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleAccountOAuth = async () => {
    if (oauthLoginRef.current) return
    const provider = accountProvider
    setView(provider === 'codex' ? 'codex-pending' : 'xai-pending')
    setLoading(true)
    setError('')
    setOAuthNotice('')
    setCodexAuthUrl('')
    setXaiAuthInfo(null)
    setOAuthSaving(false)
    setOAuthCancelling(false)
    setCopied(false)
    const attempt = { provider, unsubscribe: () => {} }
    oauthLoginRef.current = attempt
    try {
      attempt.unsubscribe =
        provider === 'codex' ?
          window.electronAPI.onCodexAuthUrl((url) => {
            if (oauthLoginRef.current === attempt) setCodexAuthUrl(url)
          })
        : window.electronAPI.onXaiAuth((info) => {
            if (oauthLoginRef.current === attempt) setXaiAuthInfo(info)
          })
      const unsubscribeAuth = attempt.unsubscribe
      const onSaving = () => {
        if (oauthLoginRef.current === attempt) {
          setOAuthSaving(true)
          setOAuthCancelling(false)
        }
      }
      const unsubscribeSaving =
        provider === 'codex' ?
          window.electronAPI.onCodexLoginSaving(onSaving)
        : window.electronAPI.onXaiLoginSaving(onSaving)
      attempt.unsubscribe = () => {
        unsubscribeAuth()
        unsubscribeSaving()
      }
      const input = {
        alias: oauthAlias.trim() || undefined,
      }
      const result = await (provider === 'codex' ?
        window.electronAPI.startCodexLogin(input)
      : window.electronAPI.startXaiLogin(input))
      if (oauthLoginRef.current !== attempt) return
      if (!result.success) {
        if (!result.cancelled) setError(result.error ?? t('auth.authFailed'))
        setView('oauth-accounts')
        return
      }
      if (!onBack) {
        onSuccess(result)
        return
      }
      await loadOAuthAccounts(provider)
      if (oauthLoginRef.current !== attempt) return
      setOAuthAlias('')
      setOAuthNotice(t('auth.codexAccountRefreshed'))
      setView('oauth-accounts')
    } catch (err) {
      if (oauthLoginRef.current === attempt) {
        setError((err as Error).message)
        setView('oauth-accounts')
      }
    } finally {
      attempt.unsubscribe()
      if (oauthLoginRef.current === attempt) {
        oauthLoginRef.current = null
        setLoading(false)
        setCodexAuthUrl('')
        setXaiAuthInfo(null)
        setOAuthSaving(false)
        setOAuthCancelling(false)
      }
    }
  }

  const handleCancelAccountOAuth = async () => {
    const attempt = oauthLoginRef.current
    if (!attempt) return
    setError('')
    setOAuthCancelling(true)
    try {
      const cancelled = await cancelOAuthLogin(attempt.provider)
      if (oauthLoginRef.current !== attempt) return
      if (cancelled) {
        attempt.unsubscribe()
        oauthLoginRef.current = null
        setView('oauth-accounts')
        setLoading(false)
        setCodexAuthUrl('')
        setXaiAuthInfo(null)
        setOAuthSaving(false)
        setOAuthCancelling(false)
      } else {
        setOAuthSaving(true)
        setOAuthCancelling(false)
      }
    } catch (err) {
      if (oauthLoginRef.current === attempt) {
        setError((err as Error).message)
        setOAuthCancelling(false)
      }
    }
  }

  const handleCopyCodexUrl = () => copyText(codexAuthUrl)

  const handleOpenCodexUrl = async () => {
    try {
      await window.electronAPI.openUrl(codexAuthUrl)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const handleOAuthSwitch = async (accountId: string) => {
    setLoading(true)
    setError('')
    setOAuthNotice('')
    try {
      const result = await (accountProvider === 'codex' ?
        window.electronAPI.switchCodexAccount(accountId)
      : window.electronAPI.switchXaiAccount(accountId))
      if (!result.success) {
        setError(result.error ?? t('auth.authFailed'))
        return
      }

      if (!onBack) {
        onSuccess(result)
        return
      }

      await loadOAuthAccounts()
      setOAuthNotice(t('auth.codexAccountRefreshed'))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const isServerRunning = async (): Promise<boolean> => {
    try {
      return (await window.electronAPI.getServerStatus()).running
    } catch {
      return false
    }
  }

  const handleOAuthRemove = async (accountId: string) => {
    setLoading(true)
    setError('')
    setOAuthNotice('')
    try {
      const result = await (accountProvider === 'codex' ?
        window.electronAPI.removeCodexAccount(accountId)
      : window.electronAPI.removeXaiAccount(accountId))
      if (!result.success) {
        setError(result.error ?? t('auth.authFailed'))
        return
      }

      await loadOAuthAccounts()
      setOAuthNotice(
        (await isServerRunning()) ?
          t('auth.codexAccountRemovedRefreshed')
        : t('auth.codexAccountRemoved'),
      )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const formatAccountId = (accountId: string): string =>
    accountId.length > 18 ?
      `${accountId.slice(0, 9)}…${accountId.slice(-6)}`
    : accountId

  const getQuickProviderLabel = (provider: QuickProviderName): string => {
    switch (provider) {
      case 'opencode-go':
        return t('auth.providerOpencodeGo')
      case 'kimi':
        return t('auth.providerKimi')
      case 'deepseek':
        return t('auth.providerDeepseek')
      case 'dashscope':
        return t('auth.providerDashscope')
      case 'openrouter':
        return t('auth.providerOpenrouter')
    }
  }

  const selectedQuickProvider =
    providerChoice === 'custom' ? null : QUICK_PROVIDER_DEFAULTS[providerChoice]
  const selectedProviderLabel =
    providerChoice === 'custom' ?
      t('auth.customProvider')
    : getQuickProviderLabel(providerChoice)
  const isProviderInput = view === 'provider-input'
  const pendingDeviceCode =
    view === 'xai-pending' ?
      xaiAuthInfo && {
        user_code: xaiAuthInfo.userCode,
        verification_uri: xaiAuthInfo.url,
      }
    : deviceCode
  const isExpandedInput = isProviderInput || view === 'oauth-accounts'
  const isCustomProvider = providerChoice === 'custom'
  const canEditProviderType =
    providerChoice === 'custom' || selectedQuickProvider?.editableType

  return (
    <div className="flex flex-col h-screen bg-canvas">
      <Header
        onOpenAuthConfig={handleBack}
        onProvidersClose={() => {
          void refreshProviderAuthStatus(
            window.electronAPI.getAuthStatus,
            onSuccess,
            !onBack,
          ).catch((reason: unknown) => setError(String(reason)))
        }}
      />

      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
        {onBack && (
          <div className="px-4 pt-3 shrink-0">
            <button
              onClick={onBack}
              className="inline-flex h-8 items-center rounded-md border border-line bg-surface px-2.5 text-[13px] font-medium text-ink-soft shadow-sm transition-colors hover:bg-sunken hover:text-ink"
            >
              {t('auth.backToHome')}
            </button>
          </div>
        )}

        <div
          className={`flex flex-col items-center justify-center flex-1 px-6 ${isExpandedInput ? 'py-4 gap-3' : 'py-6 gap-5'}`}
        >
          {/* Logo and title */}
          {!isExpandedInput && (
            <div className="text-center">
              <div className="w-14 h-14 bg-accent-strong rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-[0_10px_26px_rgba(30,41,59,0.20)] dark:bg-[#4f94f8]">
                <span className="text-white text-base font-extrabold">CA</span>
              </div>
              <h1 className="text-lg font-bold text-ink">Copilot API</h1>
              <p className="text-[13px] text-ink-faint mt-1">
                {t('auth.subtitle')}
              </p>
            </div>
          )}

          {/* Default state: provider choices */}
          {view === 'default' && (
            <div className="w-full max-w-[360px] rounded-xl border border-line-soft bg-surface p-4 shadow-[0_12px_32px_rgba(0,0,0,0.08)]">
              {/* OAuth Section */}
              <p className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider mb-2.5">
                OAuth
              </p>
              <button
                onClick={handleOAuth}
                disabled={loading}
                className="w-full py-2.5 bg-accent-strong text-white text-[13px] font-semibold rounded-lg flex items-center justify-center gap-2 hover:bg-accent-strong/90 disabled:opacity-50 transition-all mb-2"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
                </svg>
                {loading ? t('auth.loading') : t('auth.githubAuth')}
              </button>
              <button
                onClick={() => void handleOpenOAuthAccounts('codex')}
                disabled={loading}
                className="w-full py-2.5 bg-surface border border-line text-ink-soft text-[13px] font-semibold rounded-lg hover:bg-sunken hover:border-line disabled:opacity-50 transition-all mb-4"
              >
                {t('auth.codexAuth')}
              </button>
              <button
                onClick={() => void handleOpenOAuthAccounts('xai')}
                disabled={loading}
                className="w-full py-2.5 bg-surface border border-line text-ink-soft text-[13px] font-semibold rounded-lg hover:bg-sunken disabled:opacity-50 transition-all mb-4"
              >
                {t('auth.xaiAuth')}
              </button>

              {/* Divider */}
              <div className="flex items-center gap-3 mb-3">
                <div className="flex-1 border-t border-line-soft" />
                <span className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider">
                  API Key
                </span>
                <div className="flex-1 border-t border-line-soft" />
              </div>

              {/* Provider grid */}
              <div className="grid grid-cols-2 gap-2 mb-3">
                {(
                  [
                    'opencode-go',
                    'kimi',
                    'deepseek',
                    'dashscope',
                    'openrouter',
                  ] as QuickProviderName[]
                ).map((provider) => (
                  <button
                    key={provider}
                    onClick={() => handleProviderSelect(provider)}
                    className="w-full py-2.5 bg-surface border border-line text-ink-soft text-[13px] rounded-lg hover:bg-sunken hover:border-line transition-all flex items-center justify-center gap-1.5"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${PROVIDER_COLORS[provider]}`}
                    />
                    {getQuickProviderLabel(provider)}
                  </button>
                ))}
                <button
                  onClick={() => handleProviderSelect('custom')}
                  className="w-full py-2.5 bg-surface border border-line text-ink-soft text-[13px] rounded-lg hover:bg-sunken hover:border-line transition-all flex items-center justify-center gap-1.5"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                  {t('auth.customProvider')}
                </button>
              </div>

              {/* Manual token link */}
              <button
                onClick={() => setView('token-input')}
                className="w-full py-2 text-[13px] text-ink-faint hover:text-ink-soft transition-colors"
              >
                {t('auth.manualToken')}
              </button>
            </div>
          )}

          {view === 'oauth-accounts' && (
            <div className="w-full max-w-[440px] flex flex-col gap-3 rounded-xl border border-line-soft bg-surface p-4 shadow-[0_12px_32px_rgba(0,0,0,0.08)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[13px] font-semibold text-ink">
                    {t(
                      accountProvider === 'codex' ? 'auth.codexAccounts' : (
                        'auth.xaiAccounts'
                      ),
                    )}
                  </p>
                  <p className="mt-1 text-[12px] text-ink-faint">
                    {t('auth.codexAccountLimit')}
                  </p>
                </div>
                <span className="rounded-full bg-sunken px-2 py-1 text-[11px] font-semibold text-ink-faint">
                  {oauthAccounts.length}/{MAX_OAUTH_ACCOUNTS}
                </span>
              </div>

              <div className="flex flex-col gap-2">
                {oauthAccounts.length === 0 && (
                  <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[13px] text-ink-faint">
                    {t(
                      accountProvider === 'codex' ?
                        'auth.codexNoAccounts'
                      : 'auth.xaiNoAccounts',
                    )}
                  </p>
                )}
                {oauthAccounts.map((account) => (
                  <div
                    key={account.accountId}
                    className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-ink">
                          {account.alias ?? formatAccountId(account.accountId)}
                        </span>
                        {account.active && (
                          <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                            {t('auth.codexActiveAccount')}
                          </span>
                        )}
                      </div>
                      {account.alias && (
                        <p
                          className="mt-0.5 truncate font-mono text-[11px] text-ink-faint"
                          title={account.accountId}
                        >
                          {formatAccountId(account.accountId)}
                        </p>
                      )}
                    </div>
                    {!account.active && (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          onClick={() =>
                            void handleOAuthSwitch(account.accountId)
                          }
                          disabled={loading}
                          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink-soft transition-colors hover:bg-sunken disabled:opacity-50"
                        >
                          {t('auth.codexUseAccount')}
                        </button>
                        <button
                          onClick={() =>
                            void handleOAuthRemove(account.accountId)
                          }
                          disabled={loading}
                          className="rounded-md border border-red-200 px-2 py-1.5 text-[12px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-500/30 dark:hover:bg-red-500/15"
                        >
                          {t('auth.codexRemoveAccount')}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] text-ink-faint">
                    {t('auth.codexAccountAlias')}
                  </span>
                  <input
                    value={oauthAlias}
                    onChange={(event) => setOAuthAlias(event.target.value)}
                    placeholder={t('auth.codexAccountAliasPlaceholder')}
                    className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[13px] text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
                  />
                </label>
                <button
                  onClick={() => void handleAccountOAuth()}
                  disabled={loading}
                  className="w-full rounded-lg bg-accent-strong py-2.5 text-[13px] font-semibold text-white transition-all hover:bg-accent-strong/90 disabled:opacity-50"
                >
                  {loading ? t('auth.verifying') : t('auth.codexAddAccount')}
                </button>
              </div>

              {oauthNotice && (
                <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  {oauthNotice}
                </p>
              )}

              <button
                onClick={handleBack}
                className="text-center text-[13px] text-ink-faint hover:text-ink-soft"
              >
                {t('auth.back')}
              </button>
            </div>
          )}

          {/* OAuth pending state */}
          {((view === 'oauth-pending' && pendingDeviceCode)
            || view === 'xai-pending') && (
            <div className="w-full max-w-[320px] flex flex-col gap-3 rounded-xl border border-line-soft bg-surface p-4 shadow-[0_12px_32px_rgba(0,0,0,0.08)]">
              {pendingDeviceCode && !oauthSaving && (
                <>
                  <div>
                    <p className="text-[13px] text-ink-faint mb-1.5">
                      {t('auth.deviceCode')}
                    </p>
                    <div className="flex items-center gap-2 px-3 py-2.5 border border-dashed border-line rounded-lg bg-sunken">
                      <span className="font-mono text-[13px] font-bold text-ink tracking-widest flex-1">
                        {pendingDeviceCode.user_code}
                      </span>
                      <button
                        onClick={handleCopyCode}
                        className="text-[13px] text-accent hover:text-accent/80 shrink-0"
                      >
                        {copied ? t('auth.copied') : t('auth.copy')}
                      </button>
                    </div>
                  </div>
                  <div>
                    <p className="text-[13px] text-ink-faint mb-1.5">
                      {t('auth.deviceCodeUrl')}
                    </p>
                    <button
                      onClick={handleOpenDeviceUrl}
                      className="w-full px-3 py-2.5 border border-line rounded-lg bg-surface text-left text-[13px] text-accent hover:text-accent/80 hover:bg-sunken transition-colors break-all"
                    >
                      {pendingDeviceCode.verification_uri}
                    </button>
                  </div>
                  <button
                    onClick={handleOpenDeviceUrl}
                    className="w-full py-2.5 bg-accent-strong text-white text-[13px] font-semibold rounded-lg hover:bg-accent-strong/90 transition-colors"
                  >
                    {t('auth.openAuthPage')}
                  </button>
                </>
              )}
              {(polling || view === 'xai-pending') && (
                <p className="text-center text-[13px] text-ink-faint animate-pulse">
                  {view === 'xai-pending' ?
                    t(oauthSaving ? 'auth.verifying' : 'auth.waitingXaiAuth')
                  : t('auth.waitingAuth')}
                </p>
              )}
              {view === 'xai-pending' && (
                <button
                  onClick={handleCancelAccountOAuth}
                  disabled={oauthCancelling || oauthSaving}
                  className="rounded-lg border border-line bg-surface py-2.5 text-[13px] font-semibold text-ink-soft hover:bg-sunken disabled:opacity-50"
                >
                  {t(
                    oauthCancelling ? 'auth.cancelling' : (
                      'auth.cancelCodexAuth'
                    ),
                  )}
                </button>
              )}
              <button
                onClick={handleBack}
                disabled={oauthSaving || oauthCancelling}
                className="text-[13px] text-ink-faint hover:text-ink-soft text-center disabled:opacity-50"
              >
                {t('auth.back')}
              </button>
            </div>
          )}

          {/* Expanded token input state */}
          {view === 'token-input' && (
            <div className="w-full max-w-[320px] flex flex-col gap-3 rounded-xl border border-line-soft bg-surface p-4 shadow-[0_12px_32px_rgba(0,0,0,0.08)]">
              <textarea
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="gho_xxxxxxxxxxxxxxxx"
                rows={3}
                className="w-full px-3 py-2.5 border border-line rounded-lg text-[13px] resize-none focus:outline-none focus:ring-2 focus:ring-accent/40 font-mono bg-surface text-ink placeholder-ink-faint"
              />
              <button
                onClick={handleSaveToken}
                disabled={loading || !tokenInput.trim()}
                className="w-full py-2.5 bg-accent-strong text-white text-[13px] font-semibold rounded-lg hover:bg-accent-strong/90 disabled:opacity-50 transition-colors"
              >
                {loading ? t('auth.verifying') : t('auth.confirmAdd')}
              </button>
              <button
                onClick={handleBack}
                className="text-[13px] text-ink-faint hover:text-ink-soft text-center"
              >
                {t('auth.back')}
              </button>
            </div>
          )}

          {view === 'provider-input' && (
            <div
              className={`w-full ${isCustomProvider ? 'max-w-[560px]' : 'max-w-[360px]'} flex flex-col gap-2.5 rounded-xl border border-line-soft bg-surface p-4 shadow-[0_12px_32px_rgba(0,0,0,0.08)]`}
            >
              <div className="flex items-center justify-center gap-1.5 text-[13px] font-semibold text-ink">
                {!isCustomProvider && selectedQuickProvider && (
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${PROVIDER_COLORS[providerChoice]}`}
                  />
                )}
                {selectedProviderLabel}
              </div>

              <div
                className={
                  isCustomProvider ?
                    'grid gap-2.5 sm:grid-cols-2'
                  : 'flex flex-col gap-3'
                }
              >
                {isCustomProvider && (
                  <label className="flex flex-col gap-1.5 sm:col-span-2">
                    <span className="text-[13px] text-ink-faint">
                      {t('auth.modelsDevProvider')}
                    </span>
                    <select
                      value={selectedModelsDevProviderId}
                      onChange={(e) =>
                        handleModelsDevProviderSelect(e.target.value)
                      }
                      disabled={modelsDevLoading}
                      className="w-full px-3 py-2.5 border border-line rounded-lg bg-surface text-ink text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50"
                    >
                      <option value="">
                        {modelsDevLoading ?
                          t('auth.modelsDevLoading')
                        : t('auth.modelsDevManual')}
                      </option>
                      {modelsDevProviders.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name} ({provider.id}) · {provider.type}
                        </option>
                      ))}
                    </select>
                    {modelsDevError && (
                      <span className="text-[12px] text-amber-600 dark:text-amber-400">
                        {t('auth.modelsDevUnavailable')}
                      </span>
                    )}
                  </label>
                )}

                {isCustomProvider && (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[13px] text-ink-faint">
                      {t('auth.providerName')}
                    </span>
                    <input
                      value={providerName}
                      onChange={(e) => setProviderName(e.target.value)}
                      placeholder="dashscope"
                      className="w-full px-3 py-2.5 border border-line rounded-lg text-[13px] bg-surface text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
                    />
                  </label>
                )}

                {canEditProviderType && (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[13px] text-ink-faint">
                      {t('auth.providerType')}
                    </span>
                    <select
                      value={providerType}
                      onChange={(e) =>
                        setProviderType(e.target.value as ProviderType)
                      }
                      className="w-full px-3 py-2.5 border border-line rounded-lg bg-surface text-ink text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40"
                    >
                      {PROVIDER_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <label
                  className={`flex flex-col gap-1.5 ${isCustomProvider ? 'sm:col-span-2' : ''}`}
                >
                  <span className="text-[13px] text-ink-faint">
                    {t('auth.providerBaseUrl')}
                  </span>
                  <input
                    value={providerBaseUrl}
                    onChange={(e) => setProviderBaseUrl(e.target.value)}
                    placeholder="https://api.example.com"
                    className="w-full px-3 py-2.5 border border-line rounded-lg text-[13px] bg-surface text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
                  />
                </label>

                <label
                  className={`flex flex-col gap-1.5 ${isCustomProvider ? 'sm:col-span-2' : ''}`}
                >
                  <span className="text-[13px] text-ink-faint">
                    {t('auth.providerApiKey')}
                  </span>
                  <textarea
                    value={providerApiKey}
                    onChange={(e) => setProviderApiKey(e.target.value)}
                    placeholder="sk-..."
                    rows={isCustomProvider ? 2 : 3}
                    className="w-full px-3 py-2.5 border border-line rounded-lg text-[13px] resize-none focus:outline-none focus:ring-2 focus:ring-accent/40 font-mono bg-surface text-ink placeholder-ink-faint"
                  />
                </label>

                {isCustomProvider && (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[13px] text-ink-faint">
                      {t('auth.providerAuthType')}
                    </span>
                    <select
                      value={providerAuthType}
                      onChange={(e) =>
                        setProviderAuthType(
                          e.target.value as ProviderAuthTypeInput,
                        )
                      }
                      className="w-full px-3 py-2.5 border border-line rounded-lg bg-surface text-ink text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40"
                    >
                      {PROVIDER_AUTH_TYPES.map((authType) => (
                        <option key={authType} value={authType}>
                          {authType === '__default__' ?
                            t('auth.providerAuthTypeDefault')
                          : authType}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <button
                onClick={handleSaveProvider}
                disabled={loading || !providerApiKey.trim()}
                className="w-full py-2.5 bg-accent-strong text-white text-[13px] font-semibold rounded-lg hover:bg-accent-strong/90 disabled:opacity-50 transition-colors"
              >
                {loading ? t('auth.verifying') : t('auth.confirmAdd')}
              </button>
              <button
                onClick={handleBack}
                className="text-[13px] text-ink-faint hover:text-ink-soft text-center"
              >
                {t('auth.back')}
              </button>
            </div>
          )}

          {view === 'codex-pending' && (
            <div className="w-full max-w-[440px] flex flex-col gap-3 rounded-xl border border-line-soft bg-surface p-4 shadow-[0_12px_32px_rgba(0,0,0,0.08)]">
              <p className="text-center text-[13px] text-ink-faint animate-pulse">
                {oauthSaving ?
                  t('auth.codexFinishingAuth')
                : t('auth.waitingCodexAuth')}
              </p>
              {codexAuthUrl && !oauthSaving && (
                <>
                  <label className="flex flex-col gap-1.5 text-[13px] text-ink-faint">
                    {t('auth.deviceCodeUrl')}
                    <textarea
                      readOnly
                      rows={3}
                      value={codexAuthUrl}
                      onFocus={(event) => event.currentTarget.select()}
                      className="w-full resize-none rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[11px] text-ink-soft break-all"
                    />
                  </label>
                  <button
                    onClick={handleOpenCodexUrl}
                    className="w-full rounded-lg bg-accent-strong py-2.5 text-[13px] font-semibold text-white hover:bg-accent-strong/90 transition-colors"
                  >
                    {t('auth.openAuthPage')}
                  </button>
                  <button
                    onClick={handleCopyCodexUrl}
                    className="w-full rounded-lg border border-line bg-surface py-2.5 text-[13px] font-semibold text-ink-soft hover:bg-sunken transition-colors"
                  >
                    {copied ? t('auth.copied') : t('auth.copy')}
                  </button>
                </>
              )}
              <button
                onClick={handleCancelAccountOAuth}
                disabled={oauthCancelling || oauthSaving}
                className="w-full py-2.5 border border-line bg-surface text-ink-soft text-[13px] font-semibold rounded-lg hover:bg-sunken disabled:opacity-50 transition-colors"
              >
                {oauthCancelling ?
                  t('auth.cancelling')
                : t('auth.cancelCodexAuth')}
              </button>
              <button
                onClick={handleBack}
                className="text-[13px] text-ink-faint hover:text-ink-soft text-center"
              >
                {t('auth.back')}
              </button>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="w-full max-w-[440px] max-h-[168px] overflow-y-auto px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-[13px] text-red-600 flex items-start gap-1.5 dark:bg-red-500/15 dark:border-red-500/30 dark:text-red-400">
              <span className="shrink-0">⚠️</span>
              <span className="min-w-0 flex-1 break-words">{error}</span>
            </div>
          )}

          <p className="text-[13px] text-ink-faint">{t('auth.loginConsent')}</p>
        </div>
      </div>
    </div>
  )
}
