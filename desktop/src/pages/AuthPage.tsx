import { useState } from 'react'
import type { DeviceCodeInfo } from '../types/ipc'
import { useLanguage } from '../contexts/LanguageContext'
import Header from '../components/Header'

interface AuthPageProps {
  onSuccess: (username: string) => void
}

type AuthView = 'default' | 'oauth-pending' | 'token-input'

export default function AuthPage({ onSuccess }: AuthPageProps) {
  const { t } = useLanguage()
  const [view, setView] = useState<AuthView>('default')
  const [deviceCode, setDeviceCode] = useState<DeviceCodeInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [error, setError] = useState('')
  const [polling, setPolling] = useState(false)
  const [copied, setCopied] = useState(false)

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
        if (result.success && result.username) {
          onSuccess(result.username)
        } else {
          setError(result.error ?? t('auth.authFailed'))
          setView('default')
        }
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleOpenDeviceUrl = () => {
    if (deviceCode) window.electronAPI.openUrl(deviceCode.verification_uri)
  }

  const handleCopyCode = () => {
    if (!deviceCode) return
    navigator.clipboard.writeText(deviceCode.user_code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const handleSaveToken = async () => {
    if (!tokenInput.trim()) return
    setLoading(true)
    setError('')
    try {
      const result = await window.electronAPI.saveToken(tokenInput.trim())
      if (result.success && result.username) {
        onSuccess(result.username)
      } else {
        setError(result.error ?? t('auth.tokenInvalid'))
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleBack = () => {
    setView('default')
    setDeviceCode(null)
    setError('')
    setPolling(false)
    setTokenInput('')
  }

  return (
    <div className="flex flex-col h-screen bg-white">
      <Header />

      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-5">
        {/* Logo and title */}
        <div className="text-center">
          <div className="w-14 h-14 bg-[#0f172a] rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-[0_4px_14px_rgba(0,0,0,0.15)]">
            <span className="text-white text-base font-extrabold">CA</span>
          </div>
          <h1 className="text-lg font-bold text-[#0f172a]">Copilot API</h1>
          <p className="text-[13px] text-slate-400 mt-1">{t('auth.subtitle')}</p>
        </div>

        {/* Default state: two actions */}
        {view === 'default' && (
          <div className="flex flex-col gap-2 w-full max-w-[220px]">
            <button
              onClick={handleOAuth}
              disabled={loading}
              className="w-full py-2.5 bg-[#0f172a] text-white text-[13px] font-semibold rounded-lg flex items-center justify-center gap-2 hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
              </svg>
              {loading ? t('auth.loading') : t('auth.githubAuth')}
            </button>
            <button
              onClick={() => setView('token-input')}
              className="w-full py-2.5 bg-white border border-slate-200 text-slate-500 text-[13px] rounded-lg hover:bg-slate-50 transition-colors"
            >
              {t('auth.manualToken')}
            </button>
          </div>
        )}

        {/* OAuth pending state */}
        {view === 'oauth-pending' && deviceCode && (
          <div className="w-full max-w-[240px] flex flex-col gap-3">
            <div>
              <p className="text-[13px] text-slate-400 mb-1.5">{t('auth.deviceCode')}</p>
              <div className="flex items-center gap-2 px-3 py-2.5 border border-dashed border-slate-300 rounded-lg bg-slate-50">
                <span className="font-mono text-[13px] font-bold text-[#0f172a] tracking-widest flex-1">
                  {deviceCode.user_code}
                </span>
                <button
                  onClick={handleCopyCode}
                  className="text-[13px] text-blue-500 hover:text-blue-600 shrink-0"
                >
                  {copied ? t('auth.copied') : t('auth.copy')}
                </button>
              </div>
            </div>
            <button
              onClick={handleOpenDeviceUrl}
              className="w-full py-2.5 bg-[#0f172a] text-white text-[13px] font-semibold rounded-lg hover:bg-slate-800 transition-colors"
            >
              {t('auth.openAuthPage')}
            </button>
            {polling && (
              <p className="text-center text-[13px] text-slate-400 animate-pulse">
                {t('auth.waitingAuth')}
              </p>
            )}
            <button
              onClick={handleBack}
              className="text-[13px] text-slate-400 hover:text-slate-600 text-center"
            >
              {t('auth.back')}
            </button>
          </div>
        )}

        {/* Expanded token input state */}
        {view === 'token-input' && (
          <div className="w-full max-w-[240px] flex flex-col gap-3">
            <textarea
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              placeholder="gho_xxxxxxxxxxxxxxxx"
              rows={3}
              className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-[13px] resize-none focus:outline-none focus:ring-2 focus:ring-slate-300 font-mono"
            />
            <button
              onClick={handleSaveToken}
              disabled={loading || !tokenInput.trim()}
              className="w-full py-2.5 bg-[#0f172a] text-white text-[13px] font-semibold rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {loading ? t('auth.verifying') : t('auth.confirmAdd')}
            </button>
            <button
              onClick={handleBack}
              className="text-[13px] text-slate-400 hover:text-slate-600 text-center"
            >
              {t('auth.back')}
            </button>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="w-full max-w-[240px] px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-[13px] text-red-600 flex items-center gap-1.5">
            <span>⚠️</span><span>{error}</span>
          </div>
        )}

        <p className="text-[13px] text-slate-200">{t('auth.loginConsent')}</p>
      </div>
    </div>
  )
}
