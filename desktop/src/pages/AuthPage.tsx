import { useEffect, useRef, useState } from 'react'

import {
  getQuickProviderLabel,
  PROVIDER_COLORS,
  QUICK_PROVIDER_DEFAULTS,
  QUICK_PROVIDERS,
  type OAuthProvider,
  type ProviderChoice,
} from '../components/auth/auth-constants'
import { OAuthAccountsCard } from '../components/auth/OAuthAccountsCard'
import {
  CodexPendingCard,
  DeviceCodePendingCard,
} from '../components/auth/OAuthPendingCards'
import {
  ManualTokenCard,
  ProviderInputCard,
} from '../components/auth/ProviderInputCard'
import Header from '../components/Header'
import { useLanguage } from '../contexts/LanguageContext'
import { refreshProviderAuthStatus } from '../lib/provider-management-auth'
import type {
  AuthResult,
  CodexAccountSummary,
  DeviceCodeInfo,
  ModelsDevProviderOption,
  ProviderAuthInput,
  ProviderAuthTypeInput,
  ProviderType,
  XaiAuthInfo,
} from '../types/ipc'

interface AuthPageProps {
  backTarget?: 'home' | 'providers'
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

const cancelOAuthLogin = (provider: OAuthProvider) =>
  provider === 'codex' ?
    window.electronAPI.cancelCodexLogin()
  : window.electronAPI.cancelXaiLogin()

export default function AuthPage({
  backTarget = 'home',
  onBack,
  onSuccess,
}: AuthPageProps) {
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

  const pendingDeviceCode =
    view === 'xai-pending' ?
      xaiAuthInfo && {
        user_code: xaiAuthInfo.userCode,
        verification_uri: xaiAuthInfo.url,
      }
    : deviceCode

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

  const handleCopyCodexUrl = () => {
    void copyText(codexAuthUrl)
  }

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

  const isExpandedInput = view === 'provider-input' || view === 'oauth-accounts'

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
              {t(
                backTarget === 'providers' ?
                  'auth.backToProviders'
                : 'auth.backToHome',
              )}
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
                className="w-full py-2.5 bg-surface border border-line text-ink-soft text-[13px] font-semibold rounded-lg hover:bg-sunken hover:border-line disabled:opacity-50 transition-all mb-2"
              >
                {t('auth.codexAuth')}
              </button>
              <button
                onClick={() => void handleOpenOAuthAccounts('xai')}
                disabled={loading}
                className="w-full py-2.5 bg-surface border border-line text-ink-soft text-[13px] font-semibold rounded-lg hover:bg-sunken disabled:opacity-50 transition-all mb-2"
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
                {QUICK_PROVIDERS.map((provider) => (
                  <button
                    key={provider}
                    onClick={() => handleProviderSelect(provider)}
                    className="w-full py-2.5 bg-surface border border-line text-ink-soft text-[13px] rounded-lg hover:bg-sunken hover:border-line transition-all flex items-center justify-center gap-1.5"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${PROVIDER_COLORS[provider]}`}
                    />
                    {getQuickProviderLabel(t, provider)}
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
            <OAuthAccountsCard
              accountProvider={accountProvider}
              accounts={oauthAccounts}
              alias={oauthAlias}
              loading={loading}
              notice={oauthNotice}
              onAliasChange={setOAuthAlias}
              onAddAccount={() => void handleAccountOAuth()}
              onSwitchAccount={(accountId) => void handleOAuthSwitch(accountId)}
              onRemoveAccount={(accountId) => void handleOAuthRemove(accountId)}
              onBack={handleBack}
              t={t}
            />
          )}

          {/* OAuth pending state */}
          {((view === 'oauth-pending' && pendingDeviceCode)
            || view === 'xai-pending') && (
            <DeviceCodePendingCard
              copied={copied}
              deviceCode={pendingDeviceCode}
              mode={view === 'xai-pending' ? 'xai-pending' : 'oauth-pending'}
              oauthCancelling={oauthCancelling}
              oauthSaving={oauthSaving}
              onBack={handleBack}
              onCancel={() => void handleCancelAccountOAuth()}
              onCopyCode={handleCopyCode}
              onOpenDeviceUrl={handleOpenDeviceUrl}
              polling={polling}
              t={t}
            />
          )}

          {/* Expanded token input state */}
          {view === 'token-input' && (
            <ManualTokenCard
              loading={loading}
              onBack={handleBack}
              onSave={() => void handleSaveToken()}
              onTokenInputChange={setTokenInput}
              t={t}
              tokenInput={tokenInput}
            />
          )}

          {view === 'provider-input' && (
            <ProviderInputCard
              loading={loading}
              modelsDevError={modelsDevError}
              modelsDevLoading={modelsDevLoading}
              modelsDevProviders={modelsDevProviders}
              onBack={handleBack}
              onModelsDevProviderSelect={handleModelsDevProviderSelect}
              onProviderApiKeyChange={setProviderApiKey}
              onProviderAuthTypeChange={setProviderAuthType}
              onProviderBaseUrlChange={setProviderBaseUrl}
              onProviderNameChange={setProviderName}
              onProviderTypeChange={setProviderType}
              onSave={() => void handleSaveProvider()}
              providerApiKey={providerApiKey}
              providerAuthType={providerAuthType}
              providerBaseUrl={providerBaseUrl}
              providerChoice={providerChoice}
              providerName={providerName}
              providerType={providerType}
              selectedModelsDevProviderId={selectedModelsDevProviderId}
              t={t}
            />
          )}

          {view === 'codex-pending' && (
            <CodexPendingCard
              authUrl={codexAuthUrl}
              copied={copied}
              oauthCancelling={oauthCancelling}
              oauthSaving={oauthSaving}
              onBack={handleBack}
              onCancel={() => void handleCancelAccountOAuth()}
              onCopyUrl={handleCopyCodexUrl}
              onOpenUrl={() => void handleOpenCodexUrl()}
              t={t}
            />
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
